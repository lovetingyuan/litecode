import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const results = [];
async function test(language, text, check, options = {}) {
  const child = spawn(process.execPath, ['src-tauri/tools/web-language-server.cjs', '--stdio', language], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0); let id = 0; let stderr = ''; const pending = new Map(); const notifications = [];
  child.stdin.on('error', () => {});
  child.on('exit', code => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`${language} exited (${code}): ${stderr}`)); } pending.clear(); });
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
  child.stdout.on('data', b => {
    buffer = Buffer.concat([buffer, b]);
    while (true) {
      const split = buffer.indexOf('\r\n\r\n'); if (split < 0) return;
      const length = Number(buffer.subarray(0, split).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!length || buffer.length < split + 4 + length) return;
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()); buffer = buffer.subarray(split + 4 + length);
      if (message.id != null && pending.has(message.id)) { const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); }
      else notifications.push(message);
    }
  });
  function send(method, params, request = false) {
    const message = { jsonrpc: '2.0', method, params }; if (request) message.id = ++id;
    const bytes = Buffer.from(JSON.stringify(message));
    const promise = request ? new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${language} ${method} timed out: ${stderr}`)), 10_000); pending.set(id, { resolve, reject, timer }); }) : Promise.resolve();
    child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`); child.stdin.write(bytes); return promise;
  }
  try {
    const initialization = await send('initialize', { processId: process.pid, rootUri: pathToFileURL(path.resolve('.verification')).href, capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } }, initializationOptions: { schemas: options.schemas ?? [] } }, true);
    await send('initialized', {});
    const uri = pathToFileURL(path.resolve('.verification', options.filename ?? `test.${language}`)).href;
    await send('textDocument/didOpen', { textDocument: { uri, languageId: language, version: 1, text } });
    await check({ send, uri, notifications, initialization });
    results.push({ language, passed: true, capabilities: initialization.capabilities });
    await send('shutdown', null, true); await send('exit');
  } finally { child.kill(); for (const { timer } of pending.values()) clearTimeout(timer); }
}
await test('json', '{ invalid }', async ({ notifications }) => {
  const start = Date.now(); while (!notifications.some(n => n.method === 'textDocument/publishDiagnostics') && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(notifications.find(n => n.method === 'textDocument/publishDiagnostics')?.params.diagnostics.length > 0);
});
const settingsSchema = JSON.parse(await readFile('src/settings-schema.json', 'utf8'));
await test('jsonc', '{\n  // 行高\n  "editor.lineHeight": 24, /* 保留注释 */\n}', async ({ notifications, send, uri }) => {
  const start = Date.now(); while (!notifications.some(n => n.method === 'textDocument/publishDiagnostics') && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(notifications.find(n => n.method === 'textDocument/publishDiagnostics')?.params.diagnostics, []);
  const hover = await send('textDocument/hover', { textDocument: { uri }, position: { line: 2, character: 6 } }, true);
  assert.ok(JSON.stringify(hover).replaceAll('&nbsp;', ' ').includes(settingsSchema.properties['editor.lineHeight'].description), JSON.stringify(hover));
  await send('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: '{"editor.lineHeight": "invalid"}' }] });
  const changed = Date.now(); while (!notifications.some(n => n.method === 'textDocument/publishDiagnostics' && n.params.version === 2) && Date.now() - changed < 5000) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(notifications.find(n => n.method === 'textDocument/publishDiagnostics' && n.params.version === 2)?.params.diagnostics.length > 0);
}, { filename: 'settings.json', schemas: [{ uri: 'litecode://settings.schema.json', fileMatch: ['**/settings.json'], schema: settingsSchema }] });
await test('json', '{ // JSON comments remain invalid\n "valid": true,\n}', async ({ notifications }) => {
  const start = Date.now(); while (!notifications.some(n => n.method === 'textDocument/publishDiagnostics') && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(notifications.find(n => n.method === 'textDocument/publishDiagnostics')?.params.diagnostics.length > 0);
});
await test('html', '<di', async ({ send, uri }) => { const result = await send('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 3 } }, true); assert.ok(result.items.some(i => i.label === 'div')); });
await test('css', 'a { colour: red; }', async ({ notifications, send, uri }) => {
  const start = Date.now(); while (!notifications.some(n => n.method === 'textDocument/publishDiagnostics') && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(notifications.find(n => n.method === 'textDocument/publishDiagnostics')?.params.diagnostics.length > 0);
  const symbols = await send('textDocument/documentSymbol', { textDocument: { uri } }, true); assert.ok(symbols.length > 0);
});
await mkdir('docs/verification', { recursive: true }); await writeFile('docs/verification/language-server-results.json', JSON.stringify(results, null, 2)); console.log(results.map(r => `${r.language}: passed`).join('\n'));
