import { call, channel, errorMessage } from './bridge';
import { useApp, setApp, notify } from './store';
import { checkpoint, newDocument, openPath, models, showDocument, normalize, relative, patchDoc, basename, editors, patchMediaView } from './documents';
import { monaco } from './monaco';
import type { SearchMatch, DiskDocument } from './types';
import { isTextDocument } from './media';

export async function runSearch(query = useApp.getState().query) {
  const previous = useApp.getState().requestId;
  if (previous) void call('search_cancel', { requestId: previous }).catch(() => {});
  const requestId = crypto.randomUUID();
  const changed = JSON.stringify(query) !== JSON.stringify(useApp.getState().query);
  setApp({ ...(changed ? { query } : {}), results: [], searching: !!query.text, requestId, limited: false, searchErrors: [] });
  if (!query.text) return;
  try {
    await checkpoint();
    if (useApp.getState().requestId !== requestId) return;
    const onBatch = channel(batch => {
      const s = useApp.getState();
      if (s.requestId !== batch.requestId) return;
      setApp({ results: [...s.results, ...batch.matches], searching: !batch.done, limited: batch.limited, searchErrors: [...s.searchErrors, ...batch.errors] });
      void call('search_ack', { requestId: batch.requestId, sequence: batch.sequence });
    });
    await call('search_start', { requestId, query, onBatch });
    setApp(s => ({ searchHistory: [query.text, ...s.searchHistory.filter(q => q !== query.text)].slice(0, 30) }));
  } catch (e) { if (useApp.getState().requestId === requestId) setApp({ searching: false, searchErrors: [errorMessage(e)] }); }
}

export function cancelSearch() {
  const id = useApp.getState().requestId;
  if (id) void call('search_cancel', { requestId: id }).catch(() => {});
  setApp({ searching: false });
}

export async function openMatch(match: SearchMatch, side = false, group?: string) {
  const groupId = group ?? useApp.getState().activeGroup;
  if (match.documentId && useApp.getState().docs[match.documentId]?.kind === 'svg') patchMediaView(groupId, match.documentId, { mode: 'text' });
  if (match.documentId && models.has(match.documentId)) showDocument(match.documentId, { pinned: side, group: groupId, line: match.line, column: match.column });
  else await openPath(match.path, { pinned: side, group: groupId, line: match.line, column: match.column });
  // showDocument reveals the position next frame; apply the range after that reveal.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const e = editors.get(groupId);
  e?.setSelection(new monaco.Range(match.line, match.column, match.endLine, match.endColumn));
}

let navigationResults: SearchMatch[] = [];
let navigationIndex = -1;
export async function nextSearchResult(direction = 1) {
  const results = useApp.getState().results; if (!results.length) return;
  if (results !== navigationResults) { navigationResults = results; navigationIndex = direction > 0 ? -1 : 0; }
  navigationIndex = (navigationIndex + direction + results.length) % results.length;
  await openMatch(results[navigationIndex]);
}

type ReplacementEdit = { id: string; before: string; after: string; version: number };
type Transaction = { open: ReplacementEdit[]; disk: string | null };
type DiskEdit = { path: string; before: string; after: string; encoding: string; revision: string };
type Report = { succeeded: string[]; failed: string[] };
const undoStack: Transaction[] = [];
const redoStack: Transaction[] = [];

export async function replaceMatches(matches: SearchMatch[], replacement: string, preserve = false, query = useApp.getState().query, preview = false) {
  const byFile = new Map<string, SearchMatch[]>();
  matches.forEach(m => { const key = m.documentId ?? normalize(m.path); byFile.set(key, [...byFile.get(key) ?? [], m]); });
  const transaction: ReplacementEdit[] = []; const errors: string[] = [];
  const diskEdits: DiskEdit[] = [];
  for (const list of byFile.values()) {
    let temporary: monaco.editor.ITextModel | undefined;
    try {
      const first = list[0];
      const doc = first.documentId ? useApp.getState().docs[first.documentId] : Object.values(useApp.getState().docs).find(d => d.path && normalize(d.path) === normalize(first.path));
      if (doc && !isTextDocument(doc)) throw new Error(`${relative(first.path)} is no longer a text document. Search again.`);
      let disk: DiskDocument | undefined;
      if (!doc) { disk = await call<DiskDocument>('read_document', { path: first.path }); temporary = monaco.editor.createModel(disk.text); }
      const m = doc ? models.get(doc.id)! : temporary!;
      if (doc && first.version !== null && first.version !== doc.version) throw new Error(`${relative(first.path)} changed after searching. Search again.`);
      const version = m.getVersionId();
      const planned = await call<{ line: number; column: number; endLine: number; endColumn: number; text: string }[]>('replacement_plan', { text: m.getValue(), query, replacement, preserveCase: preserve });
      if (m.getVersionId() !== version) throw new Error(`${doc?.name ?? first.path} changed while preparing replacements. Search again.`);
      const edits = list.map(match => {
        const range = new monaco.Range(match.line, match.column, match.endLine, match.endColumn);
        if (m.getValueInRange(range) !== match.matched) throw new Error(`${relative(match.path)} changed after searching. Search again.`);
        const plan = planned.find(p => p.line === match.line && p.column === match.column && p.endLine === match.endLine && p.endColumn === match.endColumn);
        if (!plan) throw new Error('Search and replacement ranges changed. Search again before replacing.');
        return { range, text: plan.text };
      });
      const before = m.getValue();
      let after = before;
      for (const edit of [...edits].sort((a, b) => m.getOffsetAt(b.range.getStartPosition()) - m.getOffsetAt(a.range.getStartPosition()))) {
        const start = m.getOffsetAt(edit.range.getStartPosition()); const end = m.getOffsetAt(edit.range.getEndPosition());
        after = after.slice(0, start) + edit.text + after.slice(end);
      }
      if (preview) {
        window.dispatchEvent(new CustomEvent('show-diff', { detail: { title: `Replace Preview · ${doc?.name ?? basename(first.path)}`, before, after, language: doc?.language ?? 'plaintext' } }));
        return;
      }
      if (doc) {
        m.pushStackElement(); m.pushEditOperations([], edits, () => null); m.pushStackElement();
        transaction.push({ id: doc.id, before, after: m.getValue(), version: useApp.getState().docs[doc.id].version });
      } else if (disk) diskEdits.push({ path: first.path, before, after, encoding: disk.encoding, revision: disk.revision });
    } catch (e) { errors.push(errorMessage(e)); } finally { temporary?.dispose(); }
  }
  let diskId: string | null = null; let saved = 0;
  if (diskEdits.length) {
    const transactionId = crypto.randomUUID();
    try { const report = await call<Report>('replace_disk', { transactionId, edits: diskEdits }); saved = report.succeeded.length; errors.push(...report.failed); if (saved) diskId = transactionId; }
    catch (e) { errors.push(errorMessage(e)); }
  }
  if (transaction.length || diskId) { undoStack.push({ open: transaction, disk: diskId }); redoStack.length = 0; await checkpoint(); }
  if (!preview) notify(`${saved} closed file(s) saved; ${transaction.length} open editor(s) updated. Open editors retain unsaved edits.${errors.length ? `\n${errors.join('\n')}` : ''}`);
  return errors;
}

export async function undoReplacement(redo = false) {
  const from = redo ? redoStack : undoStack; const to = redo ? undoStack : redoStack;
  const transaction = from[from.length - 1]; if (!transaction) return;
  if (transaction.open.some(edit => models.get(edit.id)?.getValue() !== (redo ? edit.before : edit.after))) { notify('A replaced document changed. Undo those edits first, then retry the linked replacement undo.'); return; }
  for (const edit of transaction.open) {
    const m = models.get(edit.id)!;
    m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: redo ? edit.after : edit.before }], () => null); m.pushStackElement();
  }
  if (transaction.disk) {
    const report = await call<Report>('replay_replacement', { transactionId: transaction.disk, redo });
    if (report.failed.length) notify(`Replacement ${redo ? 'redo' : 'undo'} partially failed:\n${report.failed.join('\n')}`);
  }
  from.pop(); to.push(transaction); await checkpoint();
}

export async function createSearchEditor(query = useApp.getState().query, matches = useApp.getState().results, id?: string) {
  const lines = [`# Query: ${JSON.stringify(query)}`, '# Search results — edits here do not change source files.', ''];
  const files = new Map<string, SearchMatch[]>();
  for (const match of matches) files.set(match.path, [...files.get(match.path) ?? [], match]);
  for (const [path, hits] of files) {
    lines.push(`${path}:`);
    const context = Math.min(20, Math.max(0, query.context || 0));
    if (!context) { for (const hit of hits) lines.push(`  ${hit.line}:${hit.column}: ${hit.preview.replace(/\r?\n/g, '\n      ')}`); continue; }
    try {
      const doc = hits[0].documentId ? useApp.getState().docs[hits[0].documentId] : Object.values(useApp.getState().docs).find(d => d.path && normalize(d.path) === normalize(path));
      if (doc && !isTextDocument(doc)) throw new Error('This file is no longer a text document.');
      const text = doc ? models.get(doc.id)!.getValue() : (await call<DiskDocument>('read_document', { path })).text;
      const source = text.split(/\r?\n/); const included = new Set<number>();
      for (const hit of hits) for (let n = Math.max(1, hit.line - context); n <= Math.min(source.length, hit.endLine + context); n++) included.add(n);
      let previous = 0;
      for (const n of [...included].sort((a, b) => a - b)) {
        if (previous && n > previous + 1) lines.push('  …');
        const hit = hits.find(h => h.line === n);
        lines.push(hit ? `  ${n}:${hit.column}: ${source[n - 1]}` : `  ${n}: ${source[n - 1]}`); previous = n;
      }
    } catch (e) { lines.push(`  # Context unavailable: ${errorMessage(e)}`); }
  }
  if (id && models.has(id)) {
    const m = models.get(id)!; m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: lines.join('\n') }], () => null); m.pushStackElement(); patchDoc(id, { searchQuery: query }); return id;
  }
  return newDocument(lines.join('\n'), 'Search.code-search', query);
}
