import assert from 'node:assert/strict';
import { mkdir, copyFile, cp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const release = process.argv.includes('--release');
const installTools = process.argv.includes('--install-tools');
const run = path.resolve('.verification', `desktop-${Date.now()}`);
const fixture = path.join(run, 'fixture'); const app = path.join(run, 'app'); const data = path.join(app, 'data');
await mkdir(path.join(fixture, 'src', 'nested', 'empty'), { recursive: true }); await mkdir(data, { recursive: true });
await copyFile(`src-tauri/target/${release ? 'release' : 'debug'}/litecode.exe`, path.join(app, 'LiteCode.exe'));
await cp('src-tauri/tools', path.join(app, 'tools'), { recursive: true });
await writeFile(path.join(fixture, 'README.md'), '# LiteCode\r\n中文🙂 needle\r\nsecond needle\r\n');
await writeFile(path.join(fixture, 'src', 'main.ts'), 'export const greeting: string = "Hello";\nconsole.log(greeting);\n');
await writeFile(path.join(fixture, 'config.json'), '{"name":"LiteCode", "count": 1}\n');
await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'litecode-verification-fixture', private: true, type: 'module' }));
await writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2024', strict: true, types: [], noEmit: true }, include: ['src/**/*'] }));
await writeFile(path.join(fixture, '.gitignore'), 'ignored.txt\n'); await writeFile(path.join(fixture, 'ignored.txt'), 'needle\n');
spawnSync('git', ['init'], { cwd: fixture, windowsHide: true });
const native = path.resolve('.verification/language-tools/node_modules/@typescript/native-preview-win32-x64/lib/tsgo.exe');
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ 'editor.formatOnSave': true, 'typescript.native.serverPath': native, 'litecode.typescriptLanguageServerPath': path.resolve('.verification/language-tools/node_modules/typescript-language-server/lib/cli.mjs') }));
await writeFile(path.join(data, 'session-main.json'), JSON.stringify({ root: fixture, documents: [], session: {} }));
const endpoint = 'http://127.0.0.1:4446'; let session;
const checks = []; const started = Date.now();
const measurements = [];
const screenshotEnvironments = {};
const latencies = {};
function measure(windows) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', path.resolve('tools/process-resources.ps1'), '-ApplicationPath', path.join(app, 'LiteCode.exe')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr); const sample = JSON.parse(result.stdout); measurements.push({ windows, ...sample }); return sample;
}
async function command(label) { await key('p', true, true); await fill('[aria-label="Quick Access"]', `>${label}`); await key('\ue007'); await wait('return !document.querySelector(".quick-open");', 'Command palette did not close'); }
async function openFile(name) {
  await key('p', true); await fill('[aria-label="Quick Access"]', name); await key('\ue007');
  await wait(`return !document.querySelector('.quick-open') && !!document.activeElement.closest('.monaco-editor') && document.querySelector('.editor-group.focused .editor-tab.active')?.textContent.includes(${JSON.stringify(name)});`, `Editor did not focus ${name}`);
}
async function request(method, route, body) {
  const response = await fetch(endpoint + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json(); if (typeof payload.value?.error === 'string') throw new Error(`${payload.value.error}: ${payload.value.message}`); return payload.value;
}
const url = route => `/session/${session}${route}`;
async function exec(script, args = []) { return request('POST', url('/execute/sync'), { script, args }); }
async function wait(script, message, timeout = 30_000) {
  const begin = Date.now(); while (Date.now() - begin < timeout) { if (await exec(script)) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error(message);
}
async function key(key, ctrl = false, shift = false) {
  const actions = []; if (ctrl) actions.push({ type: 'keyDown', value: '\ue009' }); if (shift) actions.push({ type: 'keyDown', value: '\ue008' });
  actions.push({ type: 'keyDown', value: key }, { type: 'keyUp', value: key });
  if (shift) actions.push({ type: 'keyUp', value: '\ue008' }); if (ctrl) actions.push({ type: 'keyUp', value: '\ue009' });
  await request('POST', url('/actions'), { actions: [{ type: 'key', id: 'keyboard', actions }] });
}
async function type(text) { const active = await request('GET', url('/element/active')); await request('POST', url(`/element/${active['element-6066-11e4-a52e-4f735466cecf']}/value`), { text }); }
async function fill(selector, value) { await exec(`const e=document.querySelector(arguments[0]); if(!e) throw new Error('Missing input '+arguments[0]); e.focus(); const p=e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,arguments[1]); e.dispatchEvent(new Event('input',{bubbles:true}));`, [selector, value]); }
async function invoke(command, args = {}) { return request('POST', url('/execute/async'), { script: 'const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(v=>done({ok:true,value:v}),e=>done({ok:false,error:e}));', args: [command, args] }); }
async function screenshot(name) {
  const directory = path.resolve('docs/verification/ui', release ? 'release' : 'development'); await mkdir(directory, { recursive: true });
  screenshotEnvironments[name] = await exec('return {devicePixelRatio, innerWidth, innerHeight, outerWidth, outerHeight};');
  await writeFile(path.join(directory, `${name}.png`), Buffer.from(await request('GET', url('/screenshot')), 'base64'));
}
try {
  const response = await request('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: path.join(app, 'LiteCode.exe') }, 'ms:edgeOptions': { args: ['--remote-debugging-port=9224'] } } } });
  session = response.sessionId;
  await request('POST', url('/timeouts'), { script: 30000, implicit: 0 });
  await request('POST', url('/window/rect'), { width: 1280, height: 820, x: 40, y: 40 });
  await wait("return !!document.querySelector('file-tree-container');", 'Trees did not mount');
  const startupMs = Date.now() - started;
  checks.push('Real Tauri bootstrap, portable data directory and Trees mounting');
  await screenshot('01-explorer');
  await openFile('README');
  await wait("return !!document.querySelector('.monaco-editor');", 'Monaco did not mount an editable document');
  assert.match(await exec('return document.querySelector(".breadcrumbs").textContent;'), /README/);
  checks.push('Quick Open selects workspace file and mounts Monaco');
  await screenshot('02-editor');
  await key('f', true); await wait("return !!document.querySelector('.find-widget');", 'Find widget missing');
  checks.push('Monaco editor find widget'); await screenshot('03-find'); await key('\ue00c');
  await key('\\', true); await wait('return document.querySelectorAll(".editor-group").length===2;', 'Split editor failed');
  checks.push('Split editor groups'); await screenshot('04-split');
  await key('f', true, true); const searchStarted = performance.now(); await fill('[aria-label="Search text"]', 'needle');
  await wait('return document.querySelector(".search-summary")?.textContent.includes("2 results in 1 files");', 'Search counts or ignore semantics failed');
  latencies.searchInputToFinalResultsMs = performance.now() - searchStarted;
  checks.push('Streaming PCRE2 search, CRLF/Unicode positions, Git ignore'); await screenshot('05-search');
  await openFile('config.json');
  await key('a', true); const inputStarted = performance.now(); await type('invalid'); latencies.webdriverSendKeysMs = performance.now() - inputStarted;
  await wait('return !!document.querySelector(".squiggly-error");', 'JSON diagnostics did not reach Monaco through the IPC language client');
  checks.push('Official JSON language service diagnostics through stdio IPC and Monaco Language Client'); await screenshot('06-json-diagnostics');
  await key('s', true); await wait('return !document.querySelector(".editor-tab.active .dirty");', 'Save did not clear dirty state');
  assert.equal(await readFile(path.join(fixture, 'config.json'), 'utf8'), 'invalid'); checks.push('Real editor typing and Ctrl+S persist the buffer');
  await openFile('main.ts');
  await key('a', true); await type('const greeting: string = 123;');
  await wait('return !!document.querySelector(".editor-group.focused .squiggly-error");', 'TypeScript Native diagnostics did not reach the active editor', 45_000);
  checks.push('TypeScript Native LSP diagnostics in the real editor'); await screenshot('07-typescript-diagnostics');
  await command('Preferences: Open Keyboard Shortcuts (JSON)');
  await wait('return [...document.querySelectorAll(".editor-tab.active")].some(e=>e.textContent.includes("keybindings.json")) && !!document.activeElement.closest(".monaco-editor");', 'Keyboard shortcuts editor did not focus');
  await key('a', true); await type('[{"key":"ctrl+shift+u","command":"workbench.action.files.newUntitledFile","when":"editorTextFocus"}]'); await key('s', true);
  await wait('return !document.querySelector(".editor-group.focused .editor-tab.active .dirty");', 'Keyboard shortcut file did not save');
  await key('u', true, true);
  await wait('return !!document.querySelector(".editor-tab.active[aria-label=Untitled]");', 'Saved custom keyboard binding was not activated');
  checks.push('User keyboard shortcut JSON activates immediately with editorTextFocus context');
  await type('untitled needle'); await key('f', true, true); await fill('[aria-label="Search text"]', 'needle'); await key('\ue007');
  await wait('return document.querySelector(".search-summary")?.textContent.includes("3 results in 2 files");', 'Unsaved untitled overlay did not participate in search');
  checks.push('Untitled unsaved-buffer overlay participates in workspace search');
  const disk = await invoke('read_document', { path: path.join(fixture, 'README.md') }); assert.equal(disk.ok, true); assert.match(disk.value.text, /中文🙂/);
  const denied = await invoke('read_document', { path: path.resolve('package.json') }); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'access');
  checks.push('UTF-8/CRLF file read and window path authorization');
  const conflict = await invoke('save_document', { id: 'test-conflict', version: 1, path: path.join(fixture, 'README.md'), text: 'incorrect', encoding: 'utf8', revision: 'obsolete' }); assert.equal(conflict.error.code, 'conflict');
  assert.match(await readFile(path.join(fixture, 'README.md'), 'utf8'), /中文🙂/); checks.push('Conflict rejects stale disk writes without data loss');
  const transactionId = crypto.randomUUID();
  const before = disk.value.text; const after = before.replaceAll('needle', 'replaced');
  const report = await invoke('replace_disk', { transactionId, edits: [{ path: path.join(fixture, 'README.md'), before, after, encoding: disk.value.encoding, revision: disk.value.revision }] }); assert.equal(report.ok, true); assert.equal(report.value.succeeded.length, 1);
  assert.equal(await readFile(path.join(fixture, 'README.md'), 'utf8'), after);
  const undone = await invoke('replay_replacement', { transactionId, redo: false }); assert.equal(undone.value.succeeded.length, 1); assert.equal(await readFile(path.join(fixture, 'README.md'), 'utf8'), before);
  const redone = await invoke('replay_replacement', { transactionId, redo: true }); assert.equal(redone.value.succeeded.length, 1); assert.equal(await readFile(path.join(fixture, 'README.md'), 'utf8'), after);
  checks.push('Journaled disk replacement and version-checked undo/redo preserve CRLF and Unicode');
  if (installTools) {
    await request('POST', url('/timeouts'), { script: 300000 });
    const installed = await invoke('install_tools', { kind: 'languages' }); assert.equal(installed.ok, true, JSON.stringify(installed));
    checks.push('Verified Node download and pinned npm language tool installation');
    const formatted = await invoke('format_document', { path: null, language: 'typescript', text: 'const value={a:1,b:2}' });
    assert.equal(formatted.ok, true, JSON.stringify(formatted)); assert.match(formatted.value, /a: 1/);
    checks.push('Unsaved TypeScript stdin formatting with managed Oxfmt');
    await request('POST', url('/timeouts'), { script: 30000 });
  }
  measure(1);
  for (let index = 2; index <= 3; index++) {
    const folder = path.join(fixture, `workspace-${index}`); await mkdir(folder); await writeFile(path.join(folder, 'example.txt'), 'Another window\n');
    const opened = await invoke('open_workspace', { path: folder, newWindow: true }); assert.equal(opened.ok, true);
  }
  await wait('return document.querySelector(".workbench") !== null;', 'Main window was lost');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const threeWindows = measure(3); checks.push('Three native workspace windows in one application process');
  assert.equal(threeWindows.roots.length, 1);
  const terminated = spawnSync('taskkill.exe', ['/PID', String(threeWindows.roots[0]), '/T', '/F'], { encoding: 'utf8', windowsHide: true }); assert.equal(terminated.status, 0, terminated.stderr);
  await request('DELETE', url('')).catch(() => {}); session = undefined;
  const recovered = await request('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: path.join(app, 'LiteCode.exe') } } } }); session = recovered.sessionId;
  await wait("return !!document.querySelector('file-tree-container');", 'Application did not restart after simulated crash');
  await openFile('main.ts');
  await wait('return [...document.querySelectorAll(".editor-group.focused .view-lines")].some(e=>e.textContent.includes("123"));', 'Unsaved TypeScript content was not recovered');
  assert.ok(await exec('return !!document.querySelector(".editor-group.focused .editor-tab.active .dirty");'));
  assert.match(await readFile(path.join(fixture, 'src', 'main.ts'), 'utf8'), /Hello/);
  checks.push('Forced process-tree termination restores unsaved buffers without overwriting disk'); await screenshot('08-crash-recovery');
  await exec('window.__verificationReloadMarker=true; location.reload(); return true;');
  await wait('return !window.__verificationReloadMarker && !!document.querySelector("file-tree-container");', 'WebView did not reload');
  await openFile('main.ts');
  await wait('return !!document.querySelector(".editor-group.focused .squiggly-error");', 'Language client did not reconnect after WebView reload');
  checks.push('WebView reload reconnects language clients and retains unsaved documents');
  const environment = await exec('return {devicePixelRatio, innerWidth, innerHeight, userAgent:navigator.userAgent};');
  const metadata = { release, executableSha256: createHash('sha256').update(await readFile(path.join(app, 'LiteCode.exe'))).digest('hex'), run, fixture, startupMs, latencies, elapsedMs: Date.now() - started, capabilities: response.capabilities, environment, screenshotEnvironments, measurements, checks, screenshotsAreAcceptance: false, referenceComparison: 'NOT PERFORMED: fixed-reference binary download failed TLS handshake' };
  await mkdir('docs/verification', { recursive: true }); await writeFile('docs/verification/desktop-results.json', JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata, null, 2));
} catch (error) {
  let languageStatus;
  if (session) {
    await key('p', true, true).catch(() => {});
    await fill('[aria-label="Quick Access"]', '>Language: Show Service Status').catch(() => {});
    await key('\ue007').catch(() => {});
    languageStatus = await exec('return document.querySelector(".notification p")?.textContent;').catch(() => null);
    console.error(languageStatus);
  }
  if (session) await screenshot('failure').catch(() => {});
  await writeFile('docs/verification/desktop-failure.json', JSON.stringify({ release, run, checks, error: String(error), languageStatus }, null, 2)); throw error;
} finally { if (session) await request('DELETE', url('')).catch(() => {}); }
