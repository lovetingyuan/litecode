import { Channel } from '@tauri-apps/api/core';
import { AbstractMessageReader, AbstractMessageWriter, type Message, type DataCallback, type Disposable } from 'vscode-jsonrpc/browser';
import { MonacoLanguageClient } from 'monaco-languageclient';
import * as vscode from 'vscode';
import { RegisteredFileSystemProvider, registerFileSystemOverlay, FileType, FileSystemProviderCapabilities } from '@codingame/monaco-vscode-files-service-override';
import { createModelReference } from '@codingame/monaco-vscode-api/monaco';
import { call, desktop, errorMessage } from './bridge';
import { useApp, setApp, notify } from './store';
import { monaco } from './monaco';
import { models, openPath, normalize, visiblePath, checkpoint } from './documents';
import type { DiskDocument } from './types';
import { settingsSchema } from './settings';
import { applyEdits, format } from 'jsonc-parser';

class IpcReader extends AbstractMessageReader {
  callback?: DataCallback;
  listen(callback: DataCallback): Disposable { this.callback = callback; return { dispose: () => { this.callback = undefined; } }; }
  accept(message: Message) { this.callback?.(message); }
  close() { this.fireClose(); }
}
class IpcWriter extends AbstractMessageWriter {
  queue = Promise.resolve();
  constructor(private id: string) { super(); }
  write(message: Message) {
    return this.queue = this.queue.then(() => call<void>('lsp_send', { serverId: this.id, message })).catch(e => { this.fireError(e); throw e; });
  }
  end() { this.fireClose(); }
}
const clients = new Map<string, MonacoLanguageClient>();
const starting = new Map<string, Promise<void>>();
const failures = new Set<string>();
const failureDetails = new Map<string, string>();
const references = new Map<string, { dispose(): void }>();
const supported = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'html', 'css', 'scss', 'less', 'json', 'jsonc', 'rust']);
export const canFormat = (language: string) => supported.has(language);
function key(language: string) { return ['typescriptreact', 'javascript', 'javascriptreact'].includes(language) ? 'typescript' : language; }

class NativeFiles extends RegisteredFileSystemProvider {
  constructor() { super(false); this.capabilities = FileSystemProviderCapabilities.FileReadWrite; }
  override async readFile(uri: monaco.Uri) {
    const doc = Object.values(useApp.getState().docs).find(d => d.path && normalize(d.path) === normalize(uri.fsPath));
    if (doc && models.has(doc.id)) {return new TextEncoder().encode(models.get(doc.id)!.getValue());}
    const disk = await call<DiskDocument>('language_document', { path: uri.fsPath });
    return new TextEncoder().encode(disk.text);
  }
  override async stat(uri: monaco.Uri) {
    const bytes = await this.readFile(uri);
    return { type: FileType.File, ctime: 0, mtime: Date.now(), size: bytes.byteLength };
  }
  override async writeFile(uri: monaco.Uri, bytes: Uint8Array) {
    const id = await openPath(uri.fsPath, { pinned: true, background: true });
    if (!id) {throw new Error('Could not open workspace edit target');}
    const m = models.get(id); if (!m) {throw new Error('Cannot apply text edits to a media or binary preview');}
    m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: new TextDecoder().decode(bytes) }], () => null); m.pushStackElement();
    await checkpoint();
  }
}
let initialized = false;
export function initializeLanguages() {
  if (initialized) {return;} initialized = true;
  registerFileSystemOverlay(10, new NativeFiles());
  monaco.editor.registerEditorOpener({ openCodeEditor: async (_source, resource, selection) => {
    if (resource.scheme !== 'file') {return false;}
    try {
      await call('language_document', { path: resource.fsPath });
      const line = selection && 'startLineNumber' in selection ? selection.startLineNumber : selection?.lineNumber;
      const column = selection && 'startColumn' in selection ? selection.startColumn : selection?.column;
      await openPath(resource.fsPath, { pinned: true, line, column }); return true;
    } catch (e) { notify(errorMessage(e)); return false; }
  } });
  for (const language of supported) {
    monaco.languages.registerDocumentFormattingEditProvider(language, {
      async provideDocumentFormattingEdits(m, _options, token) {
        const version = m.getVersionId();
        try {
          const text = await formatModelText(m, language);
          if (token.isCancellationRequested || m.getVersionId() !== version) { notify('The document changed during formatting; stale edits were discarded.'); return []; }
          return [{ range: m.getFullModelRange(), text }];
        } catch (e) { notify(errorMessage(e)); return []; }
      },
    });
  }
}

export async function formatModelText(m: monaco.editor.ITextModel, language = m.getLanguageId()) {
  if (language === 'jsonc') {return applyEdits(m.getValue(), format(m.getValue(), undefined, { insertSpaces: true, tabSize: m.getOptions().tabSize, eol: m.getEOL() }));}
  const doc = Object.values(useApp.getState().docs).find(d => models.get(d.id) === m);
  return call<string>('format_document', { path: doc?.path ?? null, text: m.getValue(), language });
}

export async function formatModel(m: monaco.editor.ITextModel) {
  const version = m.getVersionId(); const text = await formatModelText(m);
  if (m.isDisposed() || m.getVersionId() !== version) {throw new Error('The document changed during formatting; stale edits were discarded.');}
  if (m.getValue() !== text) { m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null); m.pushStackElement(); }
}

export async function ensureLanguage(id: string, language: string) {
  if (!desktop || !supported.has(language)) {return;}
  const m = models.get(id); if (!m || m.uri.scheme !== 'file') {return;}
  if (!references.has(id)) {
    setApp({ languageStatus: `Registering ${language} document` });
    try { references.set(id, await createModelReference(m.uri)); } catch (e) { notify(`Language document registration: ${errorMessage(e)}`); return; }
  }
  const serverId = key(language);
  if (clients.has(serverId) || failures.has(serverId)) {return;}
  if (starting.has(serverId)) {return starting.get(serverId);}
  const pending = (async () => {
    const reader = new IpcReader(); const writer = new IpcWriter(serverId);
    const onEvent = new Channel<{ sequence: number; kind: string; message: Message | string }>();
    const logs: string[] = [];
    onEvent.onmessage = event => {
      if (event.kind === 'message') {
        reader.accept(event.message as Message);
        void call('lsp_ack', { serverId, sequence: event.sequence }).catch(() => {});
      } else if (event.kind === 'log') { if (logs.length >= 50) {logs.shift();} logs.push(String(event.message)); }
      else if (event.kind === 'exit') { reader.close(); clients.delete(serverId); setApp({ languageStatus: `${serverId} stopped` }); }
      else {notify(`${serverId}: ${String(event.message)}`);}
    };
    try {
      const description = await call<string>('lsp_start', { serverId, language: serverId, onEvent });
      const root = useApp.getState().root;
      const selector = serverId === 'typescript' ? ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'] : [language];
      const client = new MonacoLanguageClient({ id: serverId, name: description, messageTransports: { reader, writer }, clientOptions: {
        documentSelector: selector,
        workspaceFolder: root ? { uri: vscode.Uri.file(visiblePath(root)), name: root.split(/[\\/]/).pop() ?? root, index: 0 } : undefined,
        initializationOptions: { schemas: settingsSchemas() },
        middleware: { workspace: { configuration: async params => params.items.map(item => item.section ? useApp.getState().settings[item.section] ?? {} : useApp.getState().settings), handleApplyEdit: async params => applyWorkspaceEdit(params.edit) } },
        errorHandler: { error: () => ({ action: 1 }), closed: () => ({ action: 1 }) },
      } });
      await Promise.race([client.start(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Language server initialization timed out after 30 seconds')), 30_000))]);
      if (!client.isRunning()) {throw new Error(`${description} did not start. ${logs.slice(-8).join('\n')}`);}
      clients.set(serverId, client); setApp({ languageStatus: description });
    } catch (e) { failures.add(serverId); failureDetails.set(serverId, `${errorMessage(e)}\n${logs.join('\n')}`); void call('lsp_stop', { serverId }).catch(() => {}); notify(errorMessage(e)); }
    finally { starting.delete(serverId); }
  })();
  starting.set(serverId, pending); return pending;
}

export function languageReport() { return { services: [...clients].map(([id, c]) => ({ id, running: c.isRunning(), capabilities: c.initializeResult?.capabilities })), starting: [...starting.keys()], failures: Object.fromEntries(failureDetails), references: [...references.keys()], documents: vscode.workspace.textDocuments.map(d => ({ uri: d.uri.toString(), language: d.languageId, version: d.version })) }; }

async function applyWorkspaceEdit(edit: import('vscode-languageserver-protocol').WorkspaceEdit) {
  try {
    const targets = new Map<string, { version?: number | null; edits: import('vscode-languageserver-protocol').TextEdit[] }>();
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {targets.set(uri, { edits });}
    for (const change of edit.documentChanges ?? []) {
      if (!('textDocument' in change)) {return { applied: false, failureReason: 'This workspace edit contains file operations. Use Explorer for file operations.' };}
      const edits = change.edits.filter((e): e is import('vscode-languageserver-protocol').TextEdit => 'newText' in e);
      if (edits.length !== change.edits.length) {return { applied: false, failureReason: 'Snippet workspace edits are not supported' };}
      targets.set(change.textDocument.uri, { version: change.textDocument.version, edits });
    }
    const prepared: { m: monaco.editor.ITextModel; expected: number; edits: monaco.editor.IIdentifiedSingleEditOperation[] }[] = [];
    for (const [uri, target] of targets) {
      const path = monaco.Uri.parse(uri).fsPath; await call('language_document', { path });
      const id = await openPath(path, { pinned: true, background: true }); if (!id) {throw new Error('Cannot open edit target');}
      const m = models.get(id); if (!m) {throw new Error('Cannot apply text edits to a media or binary preview');}
      if (target.version != null && target.version !== m.getVersionId()) {throw new Error(`${path} changed after the language server computed its edits`);}
      prepared.push({ m, expected: m.getVersionId(), edits: target.edits.map(e => ({ range: new monaco.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1), text: e.newText })) });
    }
    if (prepared.some(p => p.expected !== p.m.getVersionId())) {throw new Error('A target changed while resolving workspace edits');}
    for (const { m, edits } of prepared) { m.pushStackElement(); m.pushEditOperations([], edits, () => null); m.pushStackElement(); }
    await checkpoint(); return { applied: true };
  } catch (e) { return { applied: false, failureReason: errorMessage(e) }; }
}

export function releaseLanguageDocument(id: string) { references.get(id)?.dispose(); references.delete(id); }
export async function restartLanguages() {
  for (const [id, client] of clients) { await client.stop(2000).catch(() => {}); await call('lsp_stop', { serverId: id }); }
  clients.clear(); failures.clear(); failureDetails.clear();
  for (const doc of Object.values(useApp.getState().docs)) {if (!doc.large) {await ensureLanguage(doc.id, doc.language);}}
}

export type SymbolItem = { name: string; path: string; line: number; column: number; kind: number };
export async function symbols(query: string, workspace: boolean): Promise<SymbolItem[]> {
  const output: SymbolItem[] = [];
  const s = useApp.getState(); const doc = s.docs[s.groups.find(g => g.id === s.activeGroup)?.active ?? ''];
  const activeModel = doc ? models.get(doc.id) : undefined;
  for (const client of clients.values()) {
    if (!client.isRunning()) {continue;}
    if (workspace && !client.initializeResult?.capabilities.workspaceSymbolProvider) {continue;}
    if (!workspace && (!activeModel || !client.initializeResult?.capabilities.documentSymbolProvider)) {continue;}
    type Symbol = { name: string; kind: number; location?: { uri: string; range: { start: { line: number; character: number } } }; selectionRange?: { start: { line: number; character: number } }; range?: { start: { line: number; character: number } }; children?: Symbol[] };
    const response = await client.sendRequest<Symbol[]>(workspace ? 'workspace/symbol' : 'textDocument/documentSymbol', workspace ? { query } : { textDocument: { uri: activeModel!.uri.toString() } });
    const visit = (list: Symbol[]) => { for (const symbol of list ?? []) {
      const start = symbol.location?.range?.start ?? symbol.selectionRange?.start ?? symbol.range?.start;
      if (start && symbol.name.toLowerCase().includes(query.toLowerCase())) {output.push({ name: symbol.name, kind: symbol.kind, path: symbol.location ? monaco.Uri.parse(symbol.location.uri).fsPath : activeModel!.uri.fsPath, line: start.line + 1, column: start.character + 1 });}
      if (symbol.children) {visit(symbol.children);}
    } };
    visit(response);
    if (!workspace) {break;}
  }
  return output;
}

export function settingsSchemas() {
  return [{ uri: 'litecode://settings.schema.json', fileMatch: ['**/settings.json'], schema: settingsSchema }];
}
