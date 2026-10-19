import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { Doc } from './types';

vi.mock('./monaco', () => ({
  monaco: {
    languages: { getLanguages: () => [{ id: 'plaintext' }] },
    Uri: { file: (path: string) => path, parse: (id: string) => id },
    editor: { getModel: () => null, createModel: vi.fn() },
  },
  loadSyntax: vi.fn().mockResolvedValue(undefined),
  languageFor: () => 'plaintext',
}));
vi.mock('./bridge', () => ({ call: vi.fn(), desktop: true, errorMessage: (e: { message: string }) => e.message }));
vi.mock('./dialog', () => ({ ask: vi.fn() }));
vi.mock('./languages', () => ({ ensureLanguage: vi.fn(), releaseLanguageDocument: vi.fn(), canFormat: vi.fn(), formatModel: vi.fn() }));

import { call } from './bridge';
import { monaco } from './monaco';
import { canFormat, formatModel } from './languages';
import { attachDocument, autoSave, editors, models, openPath, patchDoc, save, session, showDocument } from './documents';
import { setApp, useApp } from './store';

class Buffer {
  private version = 1;
  private listeners = new Set<() => void>();
  constructor(private text: string) {}
  getValue() { return this.text; }
  getAlternativeVersionId() { return this.version; }
  getEOL() { return '\n'; }
  getLanguageId() { return 'plaintext'; }
  isDisposed() { return false; }
  onDidChangeContent(listener: () => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  edit(text: string) { this.text = text; this.version++; for (const listener of this.listeners) listener(); }
}

let sequence = 0;
function addDocument(patch: Partial<Doc> = {}) {
  const id = `document-${++sequence}`;
  const doc: Doc = { id, path: `C:/workspace/${id}.txt`, name: `${id}.txt`, language: 'plaintext', encoding: 'utf8', eol: 'LF', dirty: true, version: 1, revision: 'old-revision', ...patch };
  const buffer = new Buffer('edited');
  vi.mocked(monaco.editor.createModel).mockReturnValueOnce(buffer as unknown as Monaco.editor.ITextModel);
  attachDocument(doc, buffer.getValue(), doc.dirty);
  return { id, buffer };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const writes = () => vi.mocked(call).mock.calls.filter(([command]) => command === 'save_document').map(([, args]) => args!);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(call).mockImplementation(async command => command === 'save_document' ? 'new-revision' : undefined as never);
  vi.mocked(canFormat).mockReturnValue(false);
  setApp({ docs: {}, groups: [], tabRevealRequests: {}, settings: { 'files.autoSave': 'onFocusChange' }, notice: null });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  models.clear();
  editors.clear();
  vi.unstubAllGlobals();
});

describe('Opening documents', () => {
  function setup() {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const { id } = addDocument();
    setApp({ activeGroup: 'group', groups: [{ id: 'group', tabs: [], active: null, preview: null, views: {} }], history: [], historyIndex: -1 });
    const editor = { focus: vi.fn(), setPosition: vi.fn(), revealLineInCenterIfOutsideViewport: vi.fn() };
    editors.set('group', editor as unknown as Monaco.editor.IStandaloneCodeEditor);
    return { id, editor };
  }

  it('activates an existing file as a preview without taking focus from the explorer', async () => {
    const { id, editor } = setup();
    await openPath(useApp.getState().docs[id].path!, { preserveFocus: true });
    expect(useApp.getState().groups[0]).toMatchObject({ active: id, tabs: [id], preview: id });
    expect(useApp.getState().history[0].id).toBe(id);
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it('loads a new file and preserves focus while still revealing the requested location', async () => {
    const { editor } = setup();
    vi.mocked(call).mockResolvedValueOnce({ text: 'fresh', encoding: 'utf8', eol: 'LF', revision: 'new' });
    vi.mocked(monaco.editor.createModel).mockReturnValueOnce(new Buffer('fresh') as unknown as Monaco.editor.ITextModel);
    const id = await openPath('C:/workspace/fresh.txt', { preserveFocus: true, line: 3, column: 2 });
    expect(useApp.getState().groups[0]).toMatchObject({ active: id, preview: id });
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 2 });
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it('focuses and pins the current preview when explicitly opened', () => {
    const { id, editor } = setup();
    showDocument(id, { preserveFocus: true });
    showDocument(id, { pinned: true });
    expect(useApp.getState().groups[0]).toMatchObject({ active: id, tabs: [id], preview: null });
    expect(editor.focus).toHaveBeenCalledOnce();
  });

  it('continues focusing ordinary opens and leaves background opens inactive', () => {
    const { id, editor } = setup();
    showDocument(id, { background: true });
    expect(useApp.getState().groups[0].active).toBeNull();
    expect(editor.focus).not.toHaveBeenCalled();
    showDocument(id);
    expect(editor.focus).toHaveBeenCalledOnce();
  });

  it('requests a reveal on every foreground open, including the already active document', () => {
    const { id, editor } = setup();
    showDocument(id, { preserveFocus: true });
    const first = useApp.getState().tabRevealRequests.group;
    showDocument(id, { preserveFocus: true });
    expect(useApp.getState().tabRevealRequests.group).toBe(first + 1);
    expect(useApp.getState().groups[0].tabs).toEqual([id]);
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it('does not request a reveal for background opens or change another group request', () => {
    const { id } = setup();
    showDocument(id);
    const requests = useApp.getState().tabRevealRequests;
    const other = addDocument();
    showDocument(other.id, { background: true });
    expect(useApp.getState().tabRevealRequests).toBe(requests);
    expect(useApp.getState().groups[0].active).toBe(id);
    setApp(s => ({ groups: [...s.groups, { id: 'other', tabs: [], active: null, preview: null, views: {} }] }));
    showDocument(other.id, { group: 'other' });
    expect(useApp.getState().tabRevealRequests).toEqual({ ...requests, other: 1 });
  });

  it('keeps reveal requests out of the saved session', () => {
    const { id, editor } = setup();
    Object.assign(editor, { saveViewState: () => null });
    showDocument(id);
    expect(session()).not.toHaveProperty('tabRevealRequests');
  });
});

describe('Automatic saves', () => {
  it.each([
    ['off', 'onFocusChange', 0], ['off', 'onWindowChange', 0],
    ['afterDelay', 'onFocusChange', 0], ['afterDelay', 'onWindowChange', 0],
    ['onWindowChange', 'onFocusChange', 0], ['onWindowChange', 'onWindowChange', 1],
    ['onFocusChange', 'onFocusChange', 1], ['onFocusChange', 'onWindowChange', 1],
  ] as const)('matches mode %s against event %s', async (mode, reason, count) => {
    const { id } = addDocument();
    setApp({ settings: { 'files.autoSave': mode } });
    await autoSave(reason, id);
    expect(writes()).toHaveLength(count);
  });

  it('saves the document being left, even after the active document changes', async () => {
    const previous = addDocument(); const next = addDocument();
    setApp({ activeGroup: 'group', groups: [{ id: 'group', tabs: [previous.id, next.id], active: next.id, preview: null, views: {} }] });
    await autoSave('onFocusChange', previous.id);
    expect(writes().map(args => args.id)).toEqual([previous.id]);
    expect(useApp.getState().docs[next.id].dirty).toBe(true);
    await autoSave('onFocusChange');
    expect(writes()).toHaveLength(1);
  });

  it.each(['onFocusChange', 'onWindowChange'])('saves all eligible documents on window blur in %s mode', async mode => {
    setApp({ settings: { 'files.autoSave': mode } });
    const first = addDocument(); const second = addDocument();
    addDocument({ path: null }); addDocument({ dirty: false }); addDocument({ conflict: true });
    const removed = addDocument(); models.delete(removed.id);
    await autoSave('onWindowChange');
    expect(writes().map(args => args.id)).toEqual([first.id, second.id]);
    expect(vi.mocked(call).mock.calls.some(([command]) => command === 'pick_path')).toBe(false);
  });

  it('reports failures and continues saving other documents, preserving conflicts', async () => {
    const failed = addDocument(); const good = addDocument();
    vi.mocked(call).mockImplementation(async (command, args) => {
      if (command === 'save_document' && args?.id === failed.id) throw { code: 'conflict', message: 'File changed on disk' };
      return 'new-revision' as never;
    });
    await autoSave('onWindowChange');
    expect(useApp.getState().docs[failed.id]).toMatchObject({ dirty: true, conflict: true });
    expect(useApp.getState().docs[good.id].dirty).toBe(false);
    expect(useApp.getState().notice).toBe('File changed on disk');
    await autoSave('onWindowChange');
    expect(writes()).toHaveLength(2);
  });

  it('coalesces duplicate blur and model-switch saves before formatting or writing', async () => {
    const { id } = addDocument();
    setApp({ settings: { 'files.autoSave': 'onFocusChange', 'editor.formatOnSave': true } });
    vi.mocked(canFormat).mockReturnValue(true);
    await Promise.all([autoSave('onFocusChange', id), autoSave('onFocusChange', id), autoSave('onWindowChange')]);
    expect(writes()).toHaveLength(1);
    expect(formatModel).toHaveBeenCalledTimes(1);
  });

  it.each(['off', 'onWindowChange', 'conflict', 'untitled', 'removed'] as const)('rechecks %s after waiting for an existing save', async change => {
    const { id, buffer } = addDocument(); const pending = deferred<string>();
    vi.mocked(call).mockImplementation(command => command === 'sync_documents' ? pending.promise as never : Promise.resolve('new-revision') as never);
    const manual = save(id);
    await vi.waitFor(() => expect(vi.mocked(call).mock.calls.some(([command]) => command === 'sync_documents')).toBe(true));
    buffer.edit('new edits while saving');
    const queued = autoSave('onFocusChange', id);
    if (change === 'conflict') patchDoc(id, { conflict: true });
    else if (change === 'untitled') patchDoc(id, { path: null });
    else if (change === 'removed') models.delete(id);
    else setApp({ settings: { 'files.autoSave': change } });
    pending.resolve('new-revision');
    await Promise.all([manual, queued]);
    expect(writes()).toHaveLength(1);
  });

  it('preserves edits made during a write and saves them on the next queued event', async () => {
    const { id, buffer } = addDocument(); const pending = deferred<string>();
    vi.mocked(call).mockImplementation(command => command === 'save_document' && writes().length === 1 ? pending.promise as never : Promise.resolve('next-revision') as never);
    const first = autoSave('onFocusChange', id);
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    buffer.edit('new edits while saving');
    pending.resolve('first-revision'); await first;
    expect(useApp.getState().docs[id].dirty).toBe(true);
    const second = autoSave('onFocusChange', id);
    const duplicate = autoSave('onFocusChange', id);
    await Promise.all([second, duplicate]);
    expect(writes().map(args => [args.text, args.revision])).toEqual([['edited', 'old-revision'], ['new edits while saving', 'first-revision']]);
    expect(useApp.getState().docs[id].dirty).toBe(false);
  });

  it('retains debounce timing for afterDelay and ignores focus events', async () => {
    setApp({ settings: { 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 500 } });
    const { id, buffer } = addDocument({ dirty: false });
    buffer.edit('first'); await vi.advanceTimersByTimeAsync(300); buffer.edit('last');
    await autoSave('onFocusChange', id); await autoSave('onWindowChange');
    await vi.advanceTimersByTimeAsync(499); expect(writes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes().map(args => args.text)).toEqual(['last']);
    expect(useApp.getState().docs[id].dirty).toBe(false);
  });

  it.each(['off', 'conflict', 'clean'] as const)('rechecks a pending delay when the document becomes %s', async change => {
    setApp({ settings: { 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 100 } });
    const { id, buffer } = addDocument({ dirty: false }); buffer.edit('changed');
    if (change === 'off') setApp({ settings: { 'files.autoSave': 'off' } });
    else patchDoc(id, change === 'conflict' ? { conflict: true } : { dirty: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(writes()).toHaveLength(0);
  });
});
