import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { useApp, setApp, notify } from './store';
import { commands, execute, openFolder } from './commands';
import { basename, editor, join, openPath, relative, showDocument, splitGroup, session, checkpoint } from './documents';
import { rankPath, parseLocation } from './fuzzy';
import { call, channel, errorMessage } from './bridge';
import { runSearch, openMatch } from './search';
import { FileIcon } from './EditorGroup';
import { languageFor } from './monaco';
import { Icon } from './ui';
import { symbols, type SymbolItem } from './languages';
import type { SearchMatch } from './types';

type Item = { id: string; label: string; description?: string; key?: string; path?: string; positions?: number[]; run: (side: boolean, background: boolean) => unknown };
export function QuickOpen() {
  const value = useApp(s => s.quick); const docs = useApp(s => s.docs); const tree = useApp(s => s.tree); const root = useApp(s => s.root); const recent = useApp(s => s.recent);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [selected, setSelected] = useState(0); const input = useRef<HTMLInputElement>(null); const list = useRef<HTMLDivElement>(null);
  const [symbolItems, setSymbolItems] = useState<SymbolItem[]>([]);
  const saved = useRef<ReturnType<typeof session> | null>(null); const activePosition = useRef<{ lineNumber: number; column: number } | null>(null); const committed = useRef(false);
  useEffect(() => {
    if (value === null) return;
    if (!saved.current) { saved.current = structuredClone(session()); activePosition.current = editor()?.getPosition() ?? null; committed.current = false; }
    input.current?.focus();
  }, [value]);
  useEffect(() => {
    if (!value || !['@', '#'].includes(value[0])) return;
    let cancelled = false;
    void symbols(value.slice(1).trim(), value[0] === '#').then(items => { if (!cancelled) setSymbolItems(items); }).catch(e => { if (!cancelled) notify(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [value]);
  useEffect(() => {
    if (!value?.startsWith('%')) return;
    const requestId = crypto.randomUUID(); let cancelled = false; setResults([]);
    const timer = setTimeout(() => {
      const query = { ...useApp.getState().query, text: value.slice(1).trim() }; if (!query.text) return;
      void checkpoint().then(async () => {
        if (cancelled) return;
        const onBatch = channel(batch => { if (cancelled) return; setResults(previous => [...previous, ...batch.matches]); void call('search_ack', { requestId, sequence: batch.sequence }); if (batch.errors.length) notify(batch.errors.join('\n')); });
        await call('search_start', { requestId, query, onBatch });
      }).catch(e => { if (!cancelled) notify(errorMessage(e)); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); void call('search_cancel', { requestId }).catch(() => {}); };
  }, [value]);
  const items: Item[] = useMemo(() => {
    if (value === null) return [];
    const query = value.trim();
    if (query.startsWith('>')) return commands.filter(c => c.label.toLowerCase().includes(query.slice(1).trim().toLowerCase())).map(c => ({ id: c.id, label: c.label, key: c.key, run: () => execute(c.id) }));
    if (query.startsWith('?')) return [['>', 'Show and Run Commands'], [':', 'Go to Line/Column'], [':offset ', 'Go to Character Offset'], ['@', 'Go to Symbol in Editor'], ['#', 'Go to Symbol in Workspace'], ['%', 'Quick Search'], ['edt ', 'Show Open Editors'], ['view ', 'Open a View'], ['recent ', 'Open Recent Folder']].map(([prefix, label]) => ({ id: prefix, label: prefix, description: label, run: () => { setApp({ quick: prefix }); return 'keep'; } }));
    if (query.startsWith(':')) {
      const offset = query.startsWith(':offset'); const values = query.replace(offset ? ':offset' : ':', '').trim().split(/[,:]/).map(Number);
      return [{ id: 'line', label: offset ? `Go to offset ${values[0] || 0}` : `Go to line ${values[0] || 1}, column ${values[1] || 1}`, run: () => {
        const e = editor(); const m = e?.getModel(); const position = offset ? m?.getPositionAt(Math.max(0, values[0] || 0)) : { lineNumber: Math.max(1, values[0] || 1), column: Math.max(1, values[1] || 1) };
        if (position) { e?.setPosition(position); e?.revealPositionInCenter(position); } e?.focus();
      } }];
    }
    if (query.startsWith('@') || query.startsWith('#')) return symbolItems.map((symbol, index) => ({ id: `symbol-${index}`, label: symbol.name, description: relative(symbol.path), path: symbol.path, run: async side => { await call('language_document', { path: symbol.path }); await openPath(symbol.path, { pinned: true, group: side ? splitGroup() : undefined, line: symbol.line, column: symbol.column }); } }));
    if (query.startsWith('view ')) return ['Explorer', 'Search'].filter(label => label.toLowerCase().includes(query.slice(5).toLowerCase())).map(label => ({ id: label, label, run: () => setApp({ sidebar: label === 'Explorer' ? 'explorer' : 'search' }) }));
    if (query === 'recent' || query.startsWith('recent ')) return recent.filter(path => path.toLowerCase().includes(query.slice(7).toLowerCase())).map(path => ({ id: path, label: basename(path), description: path, run: () => openFolder(false, path) }));
    if (query.startsWith('edt ')) return Object.values(docs).filter(d => d.name.toLowerCase().includes(query.slice(4).toLowerCase())).map(d => ({ id: d.id, label: d.name, description: d.path ? relative(d.path) : 'Untitled', path: d.path ?? undefined, run: () => showDocument(d.id, { pinned: true }) }));
    if (query.startsWith('%')) return results.slice(0, 100).map((m, i) => ({ id: `${i}`, label: m.preview, description: `${relative(m.path)}:${m.line}:${m.column}`, path: m.path, run: (side: boolean) => openMatch(m, side, side ? splitGroup() : undefined) }));
    const parsed = parseLocation(query);
    const paths = [...new Set([...Object.values(docs).flatMap(d => d.path ? [d.path] : []), ...(root ? tree.paths.filter(p => !p.endsWith('/')).map(p => join(root, p)) : [])])];
    const ranked = paths.map(path => rankPath(relative(path), parsed.query, Object.values(docs).some(d => d.path === path))).filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => b.score - a.score).slice(0, 100);
    const list: Item[] = ranked.map(r => {
      const path = paths.find(p => relative(p) === r.path)!;
      const label = basename(path); const offset = r.path.length - label.length;
      return { id: path, path, label, description: relative(path).split('/').slice(0, -1).join('/'), positions: r.positions.filter(p => p >= offset).map(p => p - offset), run: (side, background) => openPath(path, { pinned: true, group: side ? splitGroup() : undefined, background, line: parsed.line, column: parsed.column }) };
    });
    if (!list.length && /^(?:[a-z]:[\\/]|\\\\)/i.test(parsed.query)) list.push({ id: 'absolute', label: `Open ${parsed.query}`, run: async side => { const path = await call<string>('explicit_open', { path: parsed.query }); await openPath(path, { pinned: true, group: side ? splitGroup() : undefined, line: parsed.line, column: parsed.column }); } });
    return list;
  }, [value, docs, tree.paths, root, recent, results, symbolItems]);
  useEffect(() => { setSelected(0); }, [value]);
  useEffect(() => { list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  function close(accept: boolean) {
    if (!accept && saved.current && !committed.current) {
      setApp({ groups: saved.current.groups, activeGroup: saved.current.activeGroup, history: saved.current.history, historyIndex: saved.current.historyIndex });
      const position = activePosition.current; requestAnimationFrame(() => { if (position) editor()?.setPosition(position); editor()?.focus(); });
    }
    saved.current = null; setApp({ quick: null });
    if (accept) requestAnimationFrame(() => editor()?.focus());
  }
  async function choose(index: number, side = false, background = false) {
    const item = items[index]; if (!item) return;
    if (value?.startsWith('?')) { await item.run(side, background); return; }
    committed.current = true; close(true);
    try { await item.run(side, background); } catch (e) { notify(errorMessage(e)); }
  }
  return <Dialog.Root open={value !== null} onOpenChange={open => { if (!open) close(false); }}><Dialog.Portal><Dialog.Backdrop className="quick-backdrop" /><Dialog.Popup className="quick-open" initialFocus={input}>
    <Dialog.Title className="sr-only">Quick Access</Dialog.Title><Dialog.Description className="sr-only">Type a file name, command prefix, line number or search query.</Dialog.Description>
    <input ref={input} aria-label="Quick Access" role="combobox" aria-autocomplete="list" aria-expanded aria-controls="quick-results" aria-activedescendant={`quick-option-${selected}`} value={value ?? ''} placeholder="Search files by name (append : to go to line or @ to go to symbol)" onChange={e => setApp({ quick: e.target.value })} onKeyDown={e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => (i + items.length + (e.key === 'ArrowDown' ? 1 : -1)) % Math.max(1, items.length)); }
      if (e.key === 'Enter') { e.preventDefault(); void choose(selected, e.ctrlKey, e.altKey); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    }} />
    {value?.startsWith('%') && <button className="quick-handoff" onClick={() => { const text = value.slice(1).trim(); committed.current = true; close(true); setApp({ sidebar: 'search' }); void runSearch({ ...useApp.getState().query, text }); }}>Open in Search View <Icon name="arrow-right" /></button>}
    <div ref={list} className="quick-results" role="listbox" id="quick-results">{items.length ? items.map((item, i) => <div id={`quick-option-${i}`} data-index={i} role="option" aria-selected={selected === i} className={`quick-item ${selected === i ? 'selected' : ''}`} key={item.id} onMouseMove={() => setSelected(i)} onClick={() => void choose(i)}>{item.path ? <FileIcon language={languageFor(item.path)} /> : <Icon name={value?.startsWith('>') ? 'terminal' : 'arrow-right'} />}<span className="quick-label">{item.positions ? [...item.label].map((char, index) => item.positions!.includes(index) ? <mark key={index}>{char}</mark> : char) : item.label}</span><span className="muted quick-description">{item.description}</span>{item.key && <kbd>{item.key}</kbd>}</div>) : <div className="quick-empty">No matching results</div>}</div>
  </Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
