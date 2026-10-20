import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useApp, setApp, notify } from './store';
import { monaco } from './monaco';
import { models, editors, closeDocument, showDocument, keepOpen, relative, addHistory, moveTab, splitGroup, scheduleBackup, resolveConflict, patchDoc, openPath, checkpoint, autoSave, pathTitle, setSticky, normalizeGroup, focusDocument } from './documents';
import { errorMessage, call, channel } from './bridge';
import { Icon, IconButton } from './ui';
import { revealInTree } from './Explorer';
import { createSearchEditor } from './search';
import { EditorTabMenu } from './EditorTabMenu';
import type { Group, DiskDocument, Query, SearchMatch } from './types';
import { isGitIgnored } from './gitStatus';
import { isMarkdownDocument, isMarkdownView, isTextView } from './media';
import { MediaPreview } from './MediaPreview';
import { EditorViewMenu } from './MediaStatus';
import { MarkdownPreview } from './MarkdownPreview';

export function EditorGroup({ group }: { group: Group }) {
  const docs = useApp(s => s.docs); const activeGroup = useApp(s => s.activeGroup); const settings = useApp(s => s.settings);
  const root = useApp(s => s.root); const treeRoot = useApp(s => s.treeRoot); const git = useApp(s => s.tree.git);
  const host = useRef<HTMLDivElement>(null); const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null); const previous = useRef<string | null>(null);
  const doc = group.active ? docs[group.active] : undefined;
  const textView = !!doc && isTextView(doc, group);
  const previousTextView = useRef(false);
  const tabs = useRef<HTMLDivElement>(null);
  const revealRequest = useApp(s => s.tabRevealRequests[group.id] ?? 0);
  const activeTabIndex = group.tabs.indexOf(group.active ?? '');
  useLayoutEffect(() => {
    const element = tabs.current;
    const active = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !active) return;
    const reveal = () => {
      const viewport = element.getBoundingClientRect();
      const bounds = active.getBoundingClientRect();
      const left = element.scrollLeft + bounds.left - viewport.left;
      if (bounds.width > element.clientWidth || left < element.scrollLeft) element.scrollLeft = left;
      else if (left + bounds.width > element.scrollLeft + element.clientWidth) element.scrollLeft = left + bounds.width - element.clientWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    observer.observe(active);
    return () => observer.disconnect();
  }, [group.active, activeTabIndex, revealRequest]);
  useEffect(() => {
    const element = tabs.current; if (!element) return;
    const scroll = (event: WheelEvent) => {
      if (event.shiftKey || event.deltaX || !event.deltaY || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? element.clientHeight : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1;
      element.scrollLeft += event.deltaY * unit;
    };
    element.addEventListener('wheel', scroll, { passive: false });
    return () => element.removeEventListener('wheel', scroll);
  }, []);
  useEffect(() => {
    if (!host.current) return;
    const e = monaco.editor.create(host.current, { theme: 'dark-modern', model: null, automaticLayout: true,
      fontFamily: 'Consolas, "Courier New", monospace', fontSize: 14, lineHeight: 20, padding: { top: 8 },
      scrollBeyondLastLine: true, smoothScrolling: true, cursorBlinking: 'blink', renderLineHighlight: 'line',
      minimap: { enabled: true }, bracketPairColorization: { enabled: true }, guides: { bracketPairs: true },
      fixedOverflowWidgets: true, tabSize: 4, unicodeHighlight: { ambiguousCharacters: false },
    });
    instance.current = e; editors.set(group.id, e);
    const subscriptions = [
      e.onDidFocusEditorText(() => setApp({ activeGroup: group.id })),
      e.onDidBlurEditorWidget(() => {
        if (!document.activeElement?.closest('.editor-view-trigger, .media-menu')) void autoSave('onFocusChange', previous.current ?? undefined);
      }),
      e.onDidChangeCursorSelection(event => {
        const id = useApp.getState().groups.find(g => g.id === group.id)?.active;
        if (!id || useApp.getState().activeGroup !== group.id) return;
        const m = e.getModel(); const selection = event.selection;
        setApp({ cursor: { line: selection.positionLineNumber, column: selection.positionColumn, selected: m?.getValueLengthInRange(selection) ?? 0 } });
        if (event.source === 'api' || event.source === 'mouse') addHistory({ id, line: selection.positionLineNumber, column: selection.positionColumn });
      }),
      e.onMouseDown(event => {
        if (!event.event.detail || event.event.detail < 2) return;
        const id = useApp.getState().groups.find(g => g.id === group.id)?.active;
        const d = id ? useApp.getState().docs[id] : undefined;
        if (!d?.searchQuery || !event.target.position) return;
        const m = e.getModel(); if (!m) return;
        const line = m.getLineContent(event.target.position.lineNumber); const match = line.match(/^\s+(\d+):(\d+):/); if (!match) return;
        for (let n = event.target.position.lineNumber - 1; n > 2; n--) {
          const previous = m.getLineContent(n); if (previous && !previous.startsWith(' ')) { void openPath(previous.replace(/:$/, ''), { pinned: true, line: Number(match[1]), column: Number(match[2]) }).catch(e => notify(errorMessage(e))); break; }
        }
      }),
    ];
    return () => { subscriptions.forEach(s => s.dispose()); editors.delete(group.id); e.dispose(); instance.current = null; };
  }, [group.id]);
  useEffect(() => {
    const e = instance.current; if (!e) return;
    if (previous.current && (previous.current !== group.active || !textView) && previousTextView.current) {
      group.views[previous.current] = e.saveViewState();
      if (previous.current !== group.active) void autoSave('onFocusChange', previous.current);
    }
    e.setModel(textView && group.active ? models.get(group.active) ?? null : null);
    if (textView && group.active && (previous.current !== group.active || !previousTextView.current)) {
      const state = group.views[group.active]; if (state) e.restoreViewState(state as monaco.editor.ICodeEditorViewState);
    }
    if (previous.current === group.active && previousTextView.current !== textView) requestAnimationFrame(() => focusDocument(group.id));
    previous.current = group.active;
    previousTextView.current = textView;
  }, [group.active, group.views, doc?.path, textView]);
  useEffect(() => {
    instance.current?.updateOptions({ fontSize: Number(settings['editor.fontSize'] ?? 14), fontFamily: String(settings['editor.fontFamily'] ?? 'Consolas, "Courier New", monospace'), lineHeight: Number(settings['editor.lineHeight'] ?? 20), tabSize: Number(settings['editor.tabSize'] ?? 4), wordWrap: settings['editor.wordWrap'] === 'on' ? 'on' : 'off', minimap: { enabled: !doc?.large && settings['editor.minimap.enabled'] !== false }, folding: !doc?.large, readOnly: false });
  }, [settings, doc?.large]);
  return <section data-group-id={group.id} className={`editor-group ${activeGroup === group.id ? 'focused' : ''}`} aria-label="Editor group" onPointerDown={() => { if (activeGroup !== group.id) setApp({ activeGroup: group.id }); }} onFocus={e => { if (e.currentTarget.contains(e.target) && activeGroup !== group.id) setApp({ activeGroup: group.id }); }} onDragOver={e => e.preventDefault()} onDrop={e => {
    e.preventDefault(); const raw = e.dataTransfer.getData('application/litecode-tab'); if (!raw) return;
    const { id, from } = JSON.parse(raw); moveTab(id, from, group.id);
  }}>
    <div className="tabs-toolbar"><div className="editor-tabs" ref={tabs} role="tablist" aria-label="Open editors">{group.tabs.map(id => {
      const tab = docs[id]; if (!tab) return null;
      const sticky = !!group.sticky?.includes(id);
      return <EditorTabMenu key={id} group={group} documentId={id}><div role="tab" title={tab.path ? pathTitle(tab.path) : tab.name} tabIndex={group.active === id ? 0 : -1} aria-selected={group.active === id} aria-label={`${tab.name}${tab.dirty ? ', unsaved' : ''}`} className={`editor-tab ${group.active === id ? 'active' : ''} ${group.preview === id ? 'preview' : ''} ${sticky ? 'pinned' : ''}`} draggable onDragStart={e => e.dataTransfer.setData('application/litecode-tab', JSON.stringify({ id, from: group.id }))} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); const raw = e.dataTransfer.getData('application/litecode-tab'); if (raw) { const t = JSON.parse(raw); moveTab(t.id, t.from, group.id, id); } }} onClick={() => showDocument(id, { group: group.id })} onDoubleClick={() => keepOpen(id, group.id)} onAuxClick={e => { if (e.button === 1 && !sticky) void closeDocument(id, group.id).catch(e => notify(errorMessage(e))); }} onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDocument(id, { group: group.id }); }
        if (e.key === 'Delete' && !sticky) void closeDocument(id, group.id).catch(e => notify(errorMessage(e)));
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const index = group.tabs.indexOf(id); const next = group.tabs[(index + group.tabs.length + (e.key === 'ArrowRight' ? 1 : -1)) % group.tabs.length]; if (next) showDocument(next, { group: group.id }); }
      }}><FileIcon language={tab.language} /><span className={`editor-tab-label${isGitIgnored(tab.path, root, treeRoot, git) ? ' ignored' : ''}`}>{tab.name}</span>{tab.conflict && <Icon name="warning" />}<button className={`tab-close ${tab.dirty ? 'dirty' : ''} ${sticky ? 'tab-unpin' : ''}`} title={`${sticky ? 'Unpin' : 'Close'} ${tab.name}`} aria-label={`${sticky ? 'Unpin' : 'Close'} ${tab.name}`} onClick={e => { e.stopPropagation(); if (sticky) setSticky(id, group.id, false); else void closeDocument(id, group.id).catch(e => notify(errorMessage(e))); }}><Icon name={sticky ? 'pinned' : tab.dirty ? 'primitive-dot' : 'close'} /></button></div></EditorTabMenu>;
    })}</div><EditorTabsScrollbar viewport={tabs} tabIds={group.tabs} /><div className="actions"><IconButton icon="split-horizontal" label="Split Editor Right (Ctrl+\\)" onClick={() => splitGroup(group.id)} />{useApp.getState().groups.length > 1 && <IconButton icon="close" label="Close Editor Group" onClick={() => {
      const s = useApp.getState(); const target = s.groups.find(g => g.id !== group.id)!;
      setApp({ groups: s.groups.filter(g => g.id !== group.id).map(g => g.id === target.id ? normalizeGroup({ ...g, views: { ...group.views, ...g.views }, mediaViews: { ...group.mediaViews, ...g.mediaViews }, sticky: [...(g.sticky ?? []), ...(group.sticky ?? [])], tabs: [...new Set([...g.tabs, ...group.tabs])], active: g.active ?? group.active }) : g), activeGroup: target.id }); scheduleBackup();
    }} />}</div></div>
    {doc && <div className="breadcrumbs"><div className="breadcrumbs-path">{relative(doc.path ?? doc.name).split('/').map((segment, i, all) => {
      const remaining = all.length - i - 1;
      const path = doc.path ? pathTitle(doc.path).split('\\').slice(0, remaining ? -remaining : undefined).join('\\') : segment;
      return <span key={i}><button title={path} onClick={() => doc.path && revealInTree(doc.path)}>{i === all.length - 1 && <FileIcon language={doc.language} />}{segment}</button>{i < all.length - 1 && <Icon name="chevron-right" />}</span>;
    })}</div>{(doc.kind === 'svg' || isMarkdownDocument(doc)) && <EditorViewMenu doc={doc} group={group} />}</div>}
    {doc?.conflict && models.has(doc.id) && <div className="conflict-banner"><Icon name="warning" /><span>{doc.deleted ? 'This file was deleted from disk. Your buffer is preserved.' : 'The file changed on disk. Your edits are preserved.'}</span><button onClick={() => void compareDisk(doc.id).catch(e => notify(errorMessage(e)))}>Compare</button><button onClick={() => void resolveConflict(doc.id, 'overwrite').catch(e => notify(errorMessage(e)))}>Overwrite</button><button onClick={() => void resolveConflict(doc.id, 'reload').catch(e => notify(errorMessage(e)))}>Reload</button></div>}
    {doc?.searchQuery && <SearchEditorBar id={doc.id} query={doc.searchQuery} />}
    <div className="monaco-host" ref={host} style={{ display: doc && !textView ? 'none' : undefined, visibility: textView ? 'visible' : 'hidden' }} />
    {doc && isMarkdownView(doc, group) && <MarkdownPreview key={doc.id} doc={doc} group={group} />}
    {doc && !textView && !isMarkdownView(doc, group) && <MediaPreview key={`${doc.id}:${doc.path}`} doc={doc} group={group} />}
    {!doc && <div className="empty-editor"><div className="editor-watermark"><Icon name="code" /></div><dl><dt>Show All Commands</dt><dd>Ctrl+Shift+P</dd><dt>Go to File</dt><dd>Ctrl+P</dd><dt>Find in Files</dt><dd>Ctrl+Shift+F</dd><dt>Open Folder</dt><dd>Ctrl+K Ctrl+O</dd></dl></div>}
  </section>;
}

function EditorTabsScrollbar({ viewport, tabIds }: { viewport: RefObject<HTMLDivElement | null>; tabIds: string[] }) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current; const rail = track.current; const slider = thumb.current;
    if (!element || !rail || !slider) return;
    const update = () => {
      const width = element.clientWidth; const scrollWidth = element.scrollWidth;
      rail.hidden = width === 0 || scrollWidth <= width;
      if (rail.hidden) return;
      const thumbWidth = Math.min(width, Math.max(20, width * width / scrollWidth));
      rail.style.width = `${width}px`;
      slider.style.width = `${thumbWidth}px`;
      slider.style.transform = `translateX(${element.scrollLeft / (scrollWidth - width) * (width - thumbWidth)}px)`;
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const tab of element.children) observer.observe(tab);
    return () => { element.removeEventListener('scroll', update); observer.disconnect(); };
  }, [viewport, tabIds]);
  function scrollToPointer(clientX: number, offset: number) {
    const element = viewport.current; const rail = track.current; const slider = thumb.current;
    if (!element || !rail || !slider) return;
    const travel = rail.clientWidth - slider.getBoundingClientRect().width;
    if (travel <= 0) return;
    const position = Math.max(0, Math.min(travel, clientX - rail.getBoundingClientRect().left - offset));
    element.scrollLeft = position / travel * (element.scrollWidth - element.clientWidth);
  }
  return <div ref={track} className="editor-tabs-scrollbar" aria-hidden="true" onPointerDown={event => {
    if (event.button !== 0 || !thumb.current) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = thumb.current.getBoundingClientRect();
    dragOffset.current = event.target === thumb.current ? event.clientX - bounds.left : bounds.width / 2;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = 'true';
    scrollToPointer(event.clientX, dragOffset.current);
  }} onPointerMove={event => {
    if (dragOffset.current !== null) scrollToPointer(event.clientX, dragOffset.current);
  }} onLostPointerCapture={event => {
    dragOffset.current = null; delete event.currentTarget.dataset.dragging;
  }}><div ref={thumb} className="editor-tabs-scrollbar-thumb" /></div>;
}

function SearchEditorBar({ id, query }: { id: string; query: Query }) {
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<string | null>(null);
  useEffect(() => () => { if (current.current) void call('search_cancel', { requestId: current.current }).catch(() => {}); }, []);
  async function rerun() {
    if (current.current) await call('search_cancel', { requestId: current.current });
    const next = { ...query, text: input.current?.value ?? query.text };
    const matches: SearchMatch[] = []; const requestId = crypto.randomUUID();
    current.current = requestId; await checkpoint();
    patchDoc(id, { searchQuery: next });
    const onBatch = channel(batch => {
      if (current.current !== requestId) return;
      matches.push(...batch.matches); void call('search_ack', { requestId, sequence: batch.sequence });
      if (batch.done && !batch.cancelled) { void createSearchEditor(next, matches, id).catch(e => notify(errorMessage(e))); if (batch.errors.length) notify(batch.errors.join('\n')); }
    });
    await call('search_start', { requestId, query: next, onBatch });
  }
  return <div className="search-editor-bar"><input ref={input} aria-label="Search Editor query" defaultValue={query.text} onKeyDown={e => { if (e.key === 'Enter') void rerun().catch(e => notify(errorMessage(e))); }} /><button onClick={() => void rerun().catch(e => notify(errorMessage(e)))}><Icon name="refresh" />Search Again</button><span className="muted">Double-click a result to open its source.</span></div>;
}

export async function compareDisk(id: string) {
  const doc = useApp.getState().docs[id]; if (!doc.path) return;
  const disk = await call<DiskDocument>('read_document', { path: doc.path, force: true, encoding: doc.encoding });
  window.dispatchEvent(new CustomEvent('show-diff', { detail: { title: `${doc.name} · On Disk ↔ In Editor`, before: disk.text, after: models.get(id)?.getValue() ?? '', language: doc.language } }));
}

export function FileIcon({ language }: { language: string }) {
  const icons: Record<string, [string, string]> = { typescript: ['symbol-color', '#519aba'], javascript: ['symbol-color', '#cbcb41'], rust: ['settings-gear', '#dea584'], json: ['json', '#cbcb41'], css: ['symbol-color', '#519aba'], html: ['code', '#e37933'], markdown: ['markdown', '#519aba'] };
  const [name, color] = icons[language.replace(/react$/, '')] ?? ['file', '#a6a6a6'];
  return <span style={{ color }}><Icon name={name} /></span>;
}
