import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useApp, setApp, notify } from './store';
import { cancelSearch, createSearchEditor, openMatch, replaceMatches, runSearch } from './search';
import { basename, relative, splitGroup } from './documents';
import { Icon, IconButton } from './ui';
import { errorMessage, desktop } from './bridge';
import { ask } from './dialog';
import { revealInTree } from './Explorer';
import { FileIcon } from './EditorGroup';
import { languageFor } from './monaco';
import { searchPreview } from './searchPreview';
import { buildSearchResults, searchResultRows, searchRowMatches, type ResultRow } from './searchResults';
import type { Query, SearchMatch } from './types';

const resultHeight = 26;
const resultBottomPadding = 48;
export function SearchView() {
  const query = useApp(s => s.query); const results = useApp(s => s.results); const searching = useApp(s => s.searching);
  const root = useApp(s => s.root);
  const errors = useApp(s => s.searchErrors); const limited = useApp(s => s.limited); const history = useApp(s => s.searchHistory);
  const [replace, setReplace] = useState(false); const [replacement, setReplacement] = useState(''); const [preserve, setPreserve] = useState(false);
  const [details, setDetails] = useState(false); const [collapsed, setCollapsed] = useState(new Set<string>()); const [listMode, setListMode] = useState(true);
  const [scroll, setScroll] = useState(0); const [height, setHeight] = useState(400); const [selected, setSelected] = useState(-1);
  const [menu, setMenu] = useState<{ x: number; y: number; row: ResultRow } | null>(null);
  const viewport = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  const pendingSearch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { pendingSearch.current = setTimeout(() => void runSearch(query), 250); return () => clearTimeout(pendingSearch.current); }, [query]);
  useEffect(() => {
    const focus = () => { input.current?.focus(); input.current?.select(); };
    window.addEventListener('focus-search', focus);
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    if (viewport.current) {observer.observe(viewport.current);}
    return () => { window.removeEventListener('focus-search', focus); observer.disconnect(); };
  }, []);
  useEffect(() => { if (!menu) {return;} const close = () => setMenu(null); document.addEventListener('click', close); return () => document.removeEventListener('click', close); }, [menu]);
  const { files, tree, paths } = useMemo(() => buildSearchResults(results, root), [results, root]);
  const nodes = listMode ? files : tree;
  const allCollapsed = nodes.length > 0 && nodes.every(node => collapsed.has(node.path));
  const rows = useMemo(() => searchResultRows(nodes, collapsed), [nodes, collapsed]);
  const contentHeight = rows.length ? rows.length * resultHeight + resultBottomPadding : 0;
  useLayoutEffect(() => {
    const top = Math.min(viewport.current?.scrollTop ?? 0, Math.max(0, contentHeight - height));
    if (viewport.current) {viewport.current.scrollTop = top;}
    setScroll(top);
    if (selected >= rows.length) {setSelected(-1);}
  }, [contentHeight, rows.length, height, selected]);
  function resetSelection() { setSelected(-1); setScroll(0); if (viewport.current) {viewport.current.scrollTop = 0;} }
  function search() { clearTimeout(pendingSearch.current); resetSelection(); void runSearch(); }
  function clearResults() {
    clearTimeout(pendingSearch.current); cancelSearch();
    setApp({ requestId: null, results: [], searchErrors: [], limited: false }); resetSelection();
  }
  function update(patch: Partial<Query>) {
    cancelSearch(); resetSelection(); setApp({ query: { ...query, ...patch }, requestId: null, results: [], searchErrors: [], limited: false });
  }
  function toggle(path: string) { setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) {next.delete(path);} else {next.add(path);} return next; }); }
  function removeRow(row: ResultRow) { const removed = new Set(searchRowMatches(row)); setApp({ results: results.filter(match => !removed.has(match)) }); }
  async function replaceRows(matches: SearchMatch[], preview = false) {
    if (!preview && matches.length > 1 && await ask('Replace search results?', `Replace ${matches.length} occurrence(s)? Closed files will be saved. Open editors keep unsaved changes. Use Undo Workspace Replacement to undo this operation.`, ['Replace', 'Cancel']) !== 'Replace') {return;}
    try { await replaceMatches(matches, replacement, preserve, query, preview); if (!preview) {await runSearch(query);} } catch (e) { notify(errorMessage(e)); }
  }
  async function copy(text: string) { if (desktop) {await (await import('@tauri-apps/plugin-clipboard-manager')).writeText(text);} else {await navigator.clipboard.writeText(text);} }
  const first = Math.max(0, Math.floor(scroll / resultHeight) - 5); const visible = rows.slice(first, first + Math.ceil(height / resultHeight) + 12);
  return <section className="view search-view" aria-label="Search" style={{ '--search-result-height': `${resultHeight}px` } as CSSProperties}>
    <div className="view-title"><span>Search</span><div className="actions">
      <IconButton icon={searching ? 'search-stop' : 'refresh'} label={searching ? 'Cancel Search' : 'Refresh Search'} onClick={searching ? cancelSearch : search} />
      <IconButton icon="clear-all" label="Clear Search Results" onClick={clearResults} />
      <IconButton icon="new-file" label="Open New Search Editor" onClick={() => void createSearchEditor()} />
      <IconButton icon={listMode ? 'list-flat' : 'list-tree'} label={listMode ? 'View as Tree' : 'View as List'} onClick={() => { setListMode(!listMode); resetSelection(); }} />
      <IconButton icon={allCollapsed ? 'expand-all' : 'collapse-all'} label={allCollapsed ? 'Expand All Results' : 'Collapse All Results'} onClick={() => { setCollapsed(allCollapsed ? new Set<string>() : new Set(listMode ? files.map(file => file.path) : paths)); resetSelection(); }} />
    </div></div>
    <div className="search-form">
      <div className="search-inputs">
      <IconButton className="icon-button search-replace-toggle" icon={replace ? 'chevron-down' : 'chevron-right'} label="Toggle Replace" aria-expanded={replace} aria-controls="search-replace-row" onClick={() => setReplace(!replace)} />
      <div className="search-query-row"><div className="input-options"><textarea ref={input} value={query.text} rows={Math.min(6, query.text.split('\n').length)} placeholder="Search" aria-label="Search text" onChange={e => update({ text: e.target.value })} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); search(); }
        if (e.key === 'Escape') {cancelSearch();}
        if (e.altKey && e.key === 'ArrowUp' && history.length) {update({ text: history[Math.min(history.indexOf(query.text) + 1, history.length - 1)] });}
      }} /><div className="actions">
        <IconButton className={`icon-button option${query.caseSensitive ? ' active' : ''}`} icon="case-sensitive" label="Match Case (Alt+C)" aria-pressed={query.caseSensitive} onClick={() => update({ caseSensitive: !query.caseSensitive })} />
        <IconButton className={`icon-button option${query.wholeWord ? ' active' : ''}`} icon="whole-word" label="Match Whole Word (Alt+W)" aria-pressed={query.wholeWord} onClick={() => update({ wholeWord: !query.wholeWord })} />
        <IconButton className={`icon-button option${query.regex ? ' active' : ''}`} icon="regex" label="Use Regular Expression (Alt+R)" aria-pressed={query.regex} onClick={() => update({ regex: !query.regex })} />
      </div></div></div>
      {replace && <div className="search-query-row" id="search-replace-row"><div className="input-options"><input placeholder="Replace" aria-label="Replace text" value={replacement} onChange={e => setReplacement(e.target.value)} /><IconButton className={`icon-button option${preserve ? ' active' : ''}`} icon="preserve-case" label="Preserve Case" aria-pressed={preserve} onClick={() => setPreserve(!preserve)} /></div><IconButton className="icon-button search-replace-all" icon="replace-all" label="Replace All" disabled={!results.length} onClick={() => void replaceRows(results)} /></div>}
      </div>
      <div className="search-options-row"><IconButton icon="ellipsis" label="Toggle Search Details" aria-expanded={details} aria-controls="search-details" onClick={() => setDetails(!details)} /></div>
      {details && <div className="search-details" id="search-details">
        <label htmlFor="search-include">files to include</label>
        <div className="input-options"><input id="search-include" value={query.include} onChange={e => update({ include: e.target.value })} placeholder="e.g. *.ts, src/**/include" /><div className="actions">
          <IconButton className={`icon-button option${query.changedOnly ? ' active' : ''}`} icon="edit-code" label="Search only Changed Files" aria-pressed={query.changedOnly} onClick={() => update({ changedOnly: !query.changedOnly })} />
          <IconButton className={`icon-button option${query.openOnly ? ' active' : ''}`} icon="book" label="Search only in Open Editors" aria-pressed={query.openOnly} onClick={() => update({ openOnly: !query.openOnly })} />
        </div></div>
        <label htmlFor="search-exclude">files to exclude</label>
        <div className="input-options"><input id="search-exclude" value={query.exclude} onChange={e => update({ exclude: e.target.value })} /><div className="actions"><IconButton className={`icon-button option${query.useIgnore ? ' active' : ''}`} icon="exclude" label="Use Exclude Settings and Ignore Files" aria-pressed={query.useIgnore} onClick={() => update({ useIgnore: !query.useIgnore })} /></div></div>
      </div>}
    </div>
    <div className="search-summary" aria-live="polite">{searching ? 'Searching…' : query.text ? results.length ? `${results.length} results in ${files.length} files` : 'No results found.' : 'Search across files in your workspace.'}{results.length > 0 && <> - <button className="search-editor-link" onClick={() => void createSearchEditor()}>Open in editor</button></>}</div>
    {limited && <p className="inline-warning">Results capped at 20,000. Refine your search. Files over 20 MiB are excluded.</p>}
    {errors.map((e, i) => <p key={i} className="inline-error" role="alert">{e}</p>)}
    <div className="search-results" ref={viewport} tabIndex={0} role="tree" aria-label="Search results" onScroll={e => setScroll(e.currentTarget.scrollTop)} onKeyDown={e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!rows.length) {return;}
        const index = Math.min(rows.length - 1, Math.max(0, selected < 0 ? 0 : selected + (e.key === 'ArrowDown' ? 1 : -1))); setSelected(index);
        const top = viewport.current?.scrollTop ?? 0;
        if (index * resultHeight < top) {viewport.current?.scrollTo({ top: index * resultHeight });}
        else if ((index + 1) * resultHeight > top + height) {viewport.current?.scrollTo({ top: (index + 1) * resultHeight - height });}
      }
      const row = rows[selected]; if (!row) {return;}
      if (e.key === 'Enter') { e.preventDefault(); if (row.kind !== 'match') {toggle(row.path);} else {void openMatch(row.match).catch(e => notify(errorMessage(e)));} }
      if (e.key === 'ArrowRight' && row.kind !== 'match') { e.preventDefault(); if (collapsed.has(row.path)) {toggle(row.path);} }
      if (e.key === 'ArrowLeft' && row.kind !== 'match') { e.preventDefault(); if (!collapsed.has(row.path)) {toggle(row.path);} }
      if (e.key === 'Delete') {removeRow(row);}
    }}>
      <div style={{ height: contentHeight, position: 'relative' }}>{visible.map((row, offset) => <div role="treeitem" aria-level={row.depth + 1} aria-selected={selected === first + offset} aria-expanded={row.kind !== 'match' ? !collapsed.has(row.path) : undefined} aria-label={row.kind !== 'match' ? `${row.name}, ${row.count} matches` : `${basename(row.match.path)}:${row.match.line}:${row.match.column}: ${row.match.preview}`} key={row.kind !== 'match' ? row.path : `${row.index}:${row.match.path}`} className={`result-row ${row.kind} ${selected === first + offset ? 'selected' : ''}`} style={{ top: (first + offset) * resultHeight, paddingLeft: 18 + row.depth * 12 + (row.kind === 'match' ? 18 : 0) }} onClick={() => { setSelected(first + offset); viewport.current?.focus(); if (row.kind !== 'match') {toggle(row.path);} else {void openMatch(row.match).catch(e => notify(errorMessage(e)));} }} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}>
        {!listMode && Array.from({ length: row.depth }, (_, level) => <span key={level} className="result-indent-guide" aria-hidden="true" style={{ left: 26 + level * 12 }} />)}
        {row.kind !== 'match' ? <><Icon name={collapsed.has(row.path) ? 'chevron-right' : 'chevron-down'} />{row.kind === 'file' && <span className="result-file-icon"><FileIcon language={languageFor(row.path)} /></span>}<span className="result-filename" title={row.name}>{row.name}</span>{listMode && <span className="muted result-path" title={relative(row.path)}>{relative(row.path).split(/[\\/]/).slice(0, -1).join('\\')}</span>}<span className="count">{row.count}</span></> : <><span className="result-preview" title={`${relative(row.match.path)}:${row.match.line}:${row.match.column}\n${row.match.preview}`}>{highlight(row.match)}</span>{replace && <button className="inline-action" aria-label="Replace Match" title="Replace Match" onClick={e => { e.stopPropagation(); void replaceRows([row.match]); }}><Icon name="replace" /></button>}<button className="inline-action" aria-label="Remove Result" title="Remove Result" onClick={e => { e.stopPropagation(); removeRow(row); }}><Icon name="close" /></button></>}
      </div>)}</div>
    </div>
    {menu && <div className="context-menu floating-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 280) }}>
      {(() => {
        const row = menu.row; const matches = searchRowMatches(row); const path = row.kind !== 'match' ? row.path : row.match.path;
        const folder = row.kind === 'folder' ? relative(path) : relative(path).split('/').slice(0, -1).join('/');
        return <><button onClick={() => void openMatch(matches[0], true, splitGroup())}>Open to the Side</button><button onClick={() => void copy(matches.map(m => `${relative(m.path)}:${m.line}:${m.column}: ${m.preview}`).join('\n'))}>Copy Match</button><button onClick={() => void copy(path)}>Copy Path</button><button onClick={() => void copy(results.map(m => `${m.path}:${m.line}:${m.column}: ${m.preview}`).join('\n'))}>Copy All</button><button onClick={() => revealInTree(path)}>Reveal in Explorer</button><button onClick={() => update({ include: `${folder}/**` })}>Restrict Search to Folder</button>{row.kind !== 'folder' && <button onClick={() => update({ exclude: [query.exclude, `**/*.${path.split('.').pop()}`].filter(Boolean).join(',') })}>Exclude File Type</button>}{replace && <><button onClick={() => void replaceRows(matches, true)}>Preview Replacement</button><button onClick={() => void replaceRows(matches)}>Replace</button></>}<button onClick={() => removeRow(row)}>Remove Result</button></>;
      })()}
    </div>}
  </section>;
}

function highlight(match: SearchMatch) {
  const preview = searchPreview(match);
  return <>{preview.clipped && '…'}{preview.before}<mark>{preview.matched}</mark>{preview.after}</>;
}
