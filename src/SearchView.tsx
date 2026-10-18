import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, setApp, notify } from './store';
import { cancelSearch, createSearchEditor, openMatch, replaceMatches, runSearch } from './search';
import { basename, relative, splitGroup } from './documents';
import { Icon, IconButton } from './ui';
import { errorMessage, desktop } from './bridge';
import { ask } from './dialog';
import { revealInTree } from './Explorer';
import type { Query, SearchMatch } from './types';

type ResultRow = { kind: 'file'; path: string; count: number } | { kind: 'match'; match: SearchMatch; index: number };
export function SearchView() {
  const query = useApp(s => s.query); const results = useApp(s => s.results); const searching = useApp(s => s.searching);
  const errors = useApp(s => s.searchErrors); const limited = useApp(s => s.limited); const history = useApp(s => s.searchHistory);
  const [replace, setReplace] = useState(false); const [replacement, setReplacement] = useState(''); const [preserve, setPreserve] = useState(false);
  const [details, setDetails] = useState(false); const [collapsed, setCollapsed] = useState(new Set<string>()); const [listMode, setListMode] = useState(false);
  const [sort, setSort] = useState('path'); const [scroll, setScroll] = useState(0); const [height, setHeight] = useState(400); const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; row: ResultRow } | null>(null);
  const viewport = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = setTimeout(() => void runSearch(query), 250); return () => clearTimeout(t); }, [query]);
  useEffect(() => {
    const focus = () => { input.current?.focus(); input.current?.select(); };
    window.addEventListener('focus-search', focus);
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    if (viewport.current) observer.observe(viewport.current);
    return () => { window.removeEventListener('focus-search', focus); observer.disconnect(); };
  }, []);
  useEffect(() => { if (!menu) return; const close = () => setMenu(null); document.addEventListener('click', close); return () => document.removeEventListener('click', close); }, [menu]);
  const files = useMemo(() => {
    const files = new Map<string, SearchMatch[]>();
    for (const match of results) files.set(match.path, [...files.get(match.path) ?? [], match]);
    return [...files].sort((a, b) => sort === 'count' ? b[1].length - a[1].length : sort === 'name' ? basename(a[0]).localeCompare(basename(b[0])) : a[0].localeCompare(b[0]));
  }, [results, sort]);
  const rows: ResultRow[] = useMemo(() => {
    const rows: ResultRow[] = [];
    for (const [path, matches] of files) {
      if (!listMode) rows.push({ kind: 'file', path, count: matches.length });
      if (listMode || !collapsed.has(path)) for (const match of matches) rows.push({ kind: 'match', match, index: results.indexOf(match) });
    }
    return rows;
  }, [files, listMode, collapsed, results]);
  function update(patch: Partial<Query>) {
    cancelSearch(); setApp({ query: { ...query, ...patch }, requestId: null, results: [], searchErrors: [] });
  }
  function toggle(path: string) { setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  async function replaceRows(matches: SearchMatch[], preview = false) {
    if (!preview && matches.length > 1 && await ask('Replace search results?', `Replace ${matches.length} occurrence(s)? Closed files will be saved. Open editors keep unsaved changes. Use Undo Workspace Replacement to undo this operation.`, ['Replace', 'Cancel']) !== 'Replace') return;
    try { await replaceMatches(matches, replacement, preserve, query, preview); if (!preview) await runSearch(query); } catch (e) { notify(errorMessage(e)); }
  }
  async function copy(text: string) { if (desktop) await (await import('@tauri-apps/plugin-clipboard-manager')).writeText(text); else await navigator.clipboard.writeText(text); }
  const first = Math.max(0, Math.floor(scroll / 22) - 5); const visible = rows.slice(first, first + Math.ceil(height / 22) + 12);
  return <section className="view search-view" aria-label="Search">
    <div className="view-title"><span>SEARCH</span><div className="actions"><IconButton icon="files" label="Explorer (Ctrl+Shift+E)" onClick={() => setApp({ sidebar: 'explorer' })} /><IconButton icon="refresh" label="Refresh Search" onClick={() => void runSearch()} /><IconButton icon="new-file" label="Open New Search Editor" onClick={() => createSearchEditor()} /><IconButton icon="collapse-all" label="Collapse All Results" onClick={() => setCollapsed(new Set(files.map(([path]) => path)))} /></div></div>
    <div className="search-form">
      <div className="search-query-row"><IconButton icon={replace ? 'chevron-down' : 'chevron-right'} label="Toggle Replace" onClick={() => setReplace(!replace)} /><div className="input-options"><textarea ref={input} value={query.text} rows={Math.min(6, query.text.split('\n').length)} placeholder="Search" aria-label="Search text" onChange={e => update({ text: e.target.value })} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); void runSearch(); }
        if (e.key === 'Escape') cancelSearch();
        if (e.altKey && e.key === 'ArrowUp' && history.length) update({ text: history[Math.min(history.indexOf(query.text) + 1, history.length - 1)] });
      }} /><div className="actions"><button className={query.caseSensitive ? 'option active' : 'option'} title="Match Case (Alt+C)" aria-pressed={query.caseSensitive} onClick={() => update({ caseSensitive: !query.caseSensitive })}>Aa</button><button className={query.wholeWord ? 'option active' : 'option'} title="Match Whole Word (Alt+W)" aria-pressed={query.wholeWord} onClick={() => update({ wholeWord: !query.wholeWord })}><span className="whole-word">ab</span></button><button className={query.regex ? 'option active' : 'option'} title="Use Regular Expression (Alt+R)" aria-pressed={query.regex} onClick={() => update({ regex: !query.regex })}>.*</button></div></div></div>
      {replace && <div className="search-query-row"><span className="input-indent" /><div className="input-options"><input placeholder="Replace" aria-label="Replace text" value={replacement} onChange={e => setReplacement(e.target.value)} /><button className={preserve ? 'option active' : 'option'} aria-label="Preserve Case" aria-pressed={preserve} title="Preserve Case" onClick={() => setPreserve(!preserve)}>AB</button></div><IconButton icon="replace-all" label="Replace All" disabled={!results.length} onClick={() => void replaceRows(results)} /></div>}
      <div className="search-options-row"><button className="text-button" onClick={() => setDetails(!details)} aria-expanded={details}>{details ? 'Hide Search Details' : 'Search Details'}<Icon name={details ? 'chevron-up' : 'ellipsis'} /></button>{searching && <IconButton icon="debug-stop" label="Cancel Search" onClick={cancelSearch} />}</div>
      {details && <div className="search-details"><label>files to include<input value={query.include} onChange={e => update({ include: e.target.value })} placeholder="e.g. src/**, *.ts" /></label><label>files to exclude<input value={query.exclude} onChange={e => update({ exclude: e.target.value })} placeholder="e.g. **/node_modules/**" /></label><label className="check"><input type="checkbox" checked={query.useIgnore} onChange={e => update({ useIgnore: e.target.checked })} />Use Exclude Settings and Ignore Files</label><label className="check"><input type="checkbox" checked={query.openOnly} onChange={e => update({ openOnly: e.target.checked })} />Search only in Open Editors</label><label className="check"><input type="checkbox" checked={query.changedOnly} onChange={e => update({ changedOnly: e.target.checked })} />Search only Changed Files</label><label className="check"><input type="checkbox" checked={query.followSymlinks} onChange={e => update({ followSymlinks: e.target.checked })} />Follow Symbolic Links</label><div className="search-options-row"><select aria-label="Search result sort" value={sort} onChange={e => setSort(e.target.value)}><option value="path">Path</option><option value="name">File name</option><option value="count">Count</option></select><button className="text-button" onClick={() => setListMode(!listMode)}>{listMode ? 'Tree View' : 'List View'}</button></div></div>}
    </div>
    <div className="search-summary" aria-live="polite">{searching ? 'Searching…' : query.text ? results.length ? `${results.length} results in ${files.length} files` : 'No results found.' : 'Search across files in your workspace.'}</div>
    {limited && <p className="inline-warning">Results capped at 20,000. Refine your search. Files over 20 MiB are excluded.</p>}
    {errors.map((e, i) => <p key={i} className="inline-error" role="alert">{e}</p>)}
    <div className="search-results" ref={viewport} tabIndex={0} role="tree" aria-label="Search results" onScroll={e => setScroll(e.currentTarget.scrollTop)} onKeyDown={e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = Math.min(rows.length - 1, Math.max(0, selected + (e.key === 'ArrowDown' ? 1 : -1))); setSelected(index); viewport.current?.scrollTo({ top: Math.max(0, index * 22 - height / 2) }); }
      const row = rows[selected]; if (!row) return;
      if (e.key === 'Enter') { e.preventDefault(); if (row.kind === 'file') toggle(row.path); else void openMatch(row.match).catch(e => notify(errorMessage(e))); }
      if (e.key === 'Delete') setApp({ results: results.filter(m => row.kind === 'file' ? m.path !== row.path : m !== row.match) });
    }}>
      <div style={{ height: rows.length * 22, position: 'relative' }}>{visible.map((row, offset) => <div role="treeitem" aria-selected={selected === first + offset} aria-expanded={row.kind === 'file' ? !collapsed.has(row.path) : undefined} key={row.kind === 'file' ? row.path : `${row.index}:${row.match.path}`} className={`result-row ${row.kind} ${selected === first + offset ? 'selected' : ''}`} style={{ top: (first + offset) * 22 }} onClick={() => { setSelected(first + offset); if (row.kind === 'file') toggle(row.path); else void openMatch(row.match).catch(e => notify(errorMessage(e))); }} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}>
        {row.kind === 'file' ? <><Icon name={collapsed.has(row.path) ? 'chevron-right' : 'chevron-down'} /><Icon name="file-code" /><span className="result-filename">{basename(row.path)}</span><span className="muted result-path">{relative(row.path).split('/').slice(0, -1).join('/')}</span><span className="count">{row.count}</span></> : <><span className="result-line">{row.match.line}</span><span className="result-preview">{listMode && <span className="muted">{basename(row.match.path)}: </span>}{highlight(row.match)}</span>{replace && <button className="inline-action" title="Replace Match" onClick={e => { e.stopPropagation(); void replaceRows([row.match]); }}><Icon name="replace" /></button>}<button className="inline-action" title="Remove Result" onClick={e => { e.stopPropagation(); setApp({ results: results.filter(m => m !== row.match) }); }}><Icon name="close" /></button></>}
      </div>)}</div>
    </div>
    {menu && <div className="context-menu floating-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 280) }}>
      {(() => {
        const row = menu.row; const matches = row.kind === 'file' ? results.filter(m => m.path === row.path) : [row.match]; const path = row.kind === 'file' ? row.path : row.match.path;
        return <><button onClick={() => void openMatch(matches[0], true, splitGroup())}>Open to the Side</button><button onClick={() => void copy(matches.map(m => `${relative(m.path)}:${m.line}:${m.column}: ${m.preview}`).join('\n'))}>Copy Match</button><button onClick={() => void copy(path)}>Copy Path</button><button onClick={() => void copy(results.map(m => `${m.path}:${m.line}:${m.column}: ${m.preview}`).join('\n'))}>Copy All</button><button onClick={() => revealInTree(path)}>Reveal in Explorer</button><button onClick={() => update({ include: `${relative(path).split('/').slice(0, -1).join('/')}/**` })}>Restrict Search to Folder</button><button onClick={() => update({ exclude: [query.exclude, `**/*.${path.split('.').pop()}`].filter(Boolean).join(',') })}>Exclude File Type</button>{replace && <><button onClick={() => void replaceRows(matches, true)}>Preview Replacement</button><button onClick={() => void replaceRows(matches)}>Replace</button></>}<button onClick={() => setApp({ results: results.filter(m => !matches.includes(m)) })}>Remove Result</button></>;
      })()}
    </div>}
  </section>;
}

function highlight(match: SearchMatch) {
  const text = match.preview.split(/\r?\n/)[0]; const start = Math.max(0, match.column - 1); const end = match.endLine === match.line ? match.endColumn - 1 : text.length;
  return <>{text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}</>;
}
