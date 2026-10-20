import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { chromium } from 'playwright';

// Real Tauri IPC and media authorization, using isolated portable session data.
const appIndex = process.argv.indexOf('--app');
const executable = path.resolve(appIndex < 0 ? 'src-tauri/target/debug/litecode.exe' : process.argv[appIndex + 1]);
const run = path.resolve('.verification', `markdown-${Date.now()}`);
const app = path.join(run, 'app'), data = path.join(app, 'data'), root = path.join(run, 'fixture');
await mkdir(data, { recursive: true }); await mkdir(root, { recursive: true });
await copyFile(executable, path.join(app, 'LiteCode.exe'));
// Share read-only tool resources while keeping recovery data and fixtures isolated.
await symlink(path.resolve('src-tauri/tools'), path.join(app, 'tools'), 'junction');
await writeFile(path.join(data, 'session-main.json'), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ 'files.autoSave': 'off' }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
await writeFile(path.join(root, '图片 #+.png'), png);
await writeFile(path.join(run, 'outside.png'), png);
const images = createHttpServer((_, response) => { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); });
await new Promise(resolve => images.listen(0, '127.0.0.1', resolve));
const imageUrl = `http://127.0.0.1:${images.address().port}/image.png`;
const source = ['# Markdown 预览', '', '**Bold** and *emphasis* and ~~deleted~~.', '', '> A quoted paragraph.', '',
  '- item one', '- item two', '- [x] done', '- [ ] pending', '', '| A | B |', '| - | - |', '| 1 | 2 |', '',
  '```ts', `const text = "${'long code '.repeat(30)}";`, '```', '',
  '[Jump](#章节)', '[Guide](guide.markdown#guide)', '[Missing](missing.md)', '[Website](https://example.com)', '[Unsafe](javascript:alert)', '',
  '![Local](%E5%9B%BE%E7%89%87%20%23%2B.png)', `![HTTP](${imageUrl})`, '![HTTPS](https://markdown-test.invalid/image.png)',
  '![Missing image](missing.png)', '![Unauthorized](../outside.png)', '',
  '<script>window.markdownExecuted = true</script>', '', '<img src=x onerror="window.markdownExecuted = true">', '',
  ...Array.from({ length: 80 }, (_, n) => `Paragraph ${n}: 文档预览内容。\n`), '## 章节', '', 'Heading destination.', '## 章节', '', 'Duplicate heading.'].join('\n');
await writeFile(path.join(root, 'README.MD'), source);
await writeFile(path.join(root, 'guide.markdown'), '# Guide\n\nGuide content.');
await writeFile(path.join(root, 'empty.md'), '');
await writeFile(path.join(root, 'ordinary.txt'), 'ordinary text');
await writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const child = spawn(path.join(app, 'LiteCode.exe'), [], { cwd: app, windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server` }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
let browser, page;
const checks = [], errors = [];
try {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}: ${log}`);
    if (await fetch(`${endpoint}/json/version`).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('https://markdown-test.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.waitForURL('http://localhost:1420/**', { waitUntil: 'commit', timeout: 60000 });
  await page.locator('file-tree-container').waitFor({ timeout: 180000 });
  console.log('Desktop ready');
  const urls = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('resource').flatMap(entry => {
    const match = new URL(entry.name).pathname.match(/^\/src\/(documents|store|bridge)\.ts$/);
    return match ? [[match[1], entry.name]] : [];
  })));
  const action = (module, method, ...args) => page.evaluate(async ({ url, method, args }) => (await import(url))[method](...args), { url: urls[module], method, args });
  const state = () => page.evaluate(async url => {
    const s = (await import(url)).useApp.getState(); return { docs: s.docs, groups: s.groups, activeGroup: s.activeGroup };
  }, urls.store);
  const open = name => action('documents', 'openPath', path.join(root, name), { pinned: true });
  const group = id => page.locator(`[data-group-id="${id}"]`);
  async function mode(id, label) {
    await group(id).getByRole('button', { name: 'Select Markdown editor', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  const id = await open('README.MD'); const first = (await state()).activeGroup;
  await group(first).getByRole('button', { name: 'Select Markdown editor' }).waitFor();
  assert.equal(await group(first).getByRole('button', { name: 'Select Markdown editor' }).innerText(), 'Text Editor');
  const changed = source.replace('# Markdown 预览', '# Unsaved 预览');
  await page.evaluate(async ({ url, id, text, groupId }) => {
    const { models, editors } = await import(url); const m = models.get(id); const e = editors.get(groupId);
    m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null); m.pushStackElement();
    e.setSelection({ startLineNumber: 8, startColumn: 2, endLineNumber: 8, endColumn: 6 });
  }, { url: urls.documents, id, text: changed, groupId: first });
  const trigger = group(first).getByRole('button', { name: 'Select Markdown editor' });
  await trigger.focus(); await trigger.press('ArrowDown');
  await page.getByRole('menuitem', { name: 'Text Editor', exact: true }).waitFor();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await group(first).getByRole('heading', { name: 'Unsaved 预览', exact: true }).waitFor();
  assert.equal(await group(first).locator('.monaco-host').isVisible(), false);
  assert.equal((await state()).docs[id].dirty, true);
  assert.equal(await readFile(path.join(root, 'README.MD'), 'utf8'), source);
  assert.doesNotMatch(await page.locator('.status-right').innerText(), /Ln \d/);
  assert.equal(await group(first).locator('table tbody td').count(), 2);
  assert.equal(await group(first).locator('input[type="checkbox"][disabled]').count(), 2);
  await group(first).getByAltText('Local', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.markdown-body img')].length === 3 && [...document.querySelectorAll('.markdown-body img')].every(img => img.naturalWidth === 1));
  await group(first).getByRole('img', { name: 'Missing image', exact: true }).waitFor();
  assert.equal(await group(first).locator('.markdown-image-error').count(), 2);
  assert.equal(await group(first).getByRole('link', { name: 'Unsafe', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.equal(await group(first).locator('.markdown-body script, .markdown-body iframe, .markdown-body [onerror]').count(), 0);
  const denied = await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url: 'file:///C:/not-granted.txt' }); return false; }
    catch { return true; }
  });
  assert.equal(denied, true);
  await page.screenshot({ path: path.join(run, '01-markdown-preview.png') });
  checks.push('Text default, keyboard menu, unsaved buffer, GFM, safe HTML/URLs, local/HTTP/HTTPS images and authorized-file boundary');
  console.log(checks.at(-1));

  await group(first).getByRole('link', { name: 'Jump', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.markdown-preview').scrollTop > 500);
  assert.equal(await group(first).locator('#markdown-章节').count(), 1);
  assert.equal(await group(first).locator('#markdown-章节-1').count(), 1);
  const scroll = await group(first).locator('.markdown-preview').evaluate(el => el.scrollTop);
  await open('ordinary.txt'); await action('documents', 'showDocument', id);
  await page.waitForFunction(expected => Math.abs(document.querySelector('.markdown-preview')?.scrollTop - expected) < 2, scroll);
  await mode(first, 'Text Editor');
  const selection = await page.evaluate(async ({ url, groupId }) => (await import(url)).editors.get(groupId).getSelection(), { url: urls.documents, groupId: first });
  assert.equal(selection.startLineNumber, 8); assert.equal(selection.endColumn, 6);
  await page.evaluate(async ({ url, id }) => (await import(url)).models.get(id).undo(), { url: urls.documents, id });
  assert.equal((await state()).docs[id].dirty, false);
  await page.evaluate(async ({ url, id }) => (await import(url)).models.get(id).redo(), { url: urls.documents, id });
  assert.equal((await state()).docs[id].dirty, true);
  checks.push('Unicode/duplicate heading anchors, preview scroll restore, source selection and undo/redo retained');
  console.log(checks.at(-1));

  const second = await action('documents', 'splitGroup', first);
  await mode(second, 'Markdown Preview');
  await page.evaluate(async ({ url, id }) => {
    const m = (await import(url)).models.get(id);
    m.pushEditOperations([], [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: m.getLineMaxColumn(1) }, text: '# Live split preview' }], () => null);
  }, { url: urls.documents, id });
  await group(second).getByRole('heading', { name: 'Live split preview', exact: true }).waitFor();
  assert.equal(await group(first).locator('.monaco-host').isVisible(), true);
  assert.equal(await group(second).locator('.monaco-host').isVisible(), false);
  await group(second).locator('.markdown-preview').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(run, '02-split-live.png') });
  await group(second).locator('.markdown-preview').evaluate(el => { el.scrollTop = 200; });
  await page.waitForFunction(() => document.querySelector('.editor-group.focused .markdown-preview')?.scrollTop === 200);
  await action('documents', 'checkpoint'); await page.reload({ waitUntil: 'commit' }); await page.locator('file-tree-container').waitFor({ timeout: 180000 });
  await group(second).getByRole('heading', { name: 'Live split preview', exact: true }).waitFor();
  assert.equal(await group(first).locator('.monaco-host').isVisible(), true);
  assert.equal((await state()).docs[id].dirty, true);
  await page.waitForFunction(() => document.querySelector('.editor-group.focused .markdown-preview')?.scrollTop === 200);
  await action('documents', 'showDocument', id, { group: second, line: 8, column: 3 });
  await group(second).locator('.monaco-host').waitFor({ state: 'visible' });
  const position = await page.evaluate(async ({ url, groupId }) => (await import(url)).editors.get(groupId).getPosition(), { url: urls.documents, groupId: second });
  assert.equal(position.lineNumber, 8); assert.equal(position.column, 3);
  checks.push('Independent split modes, live edits, session recovery with unsaved content and source-line navigation');
  console.log(checks.at(-1));

  await mode(second, 'Markdown Preview');
  await group(second).getByRole('link', { name: 'Guide', exact: true }).click();
  await group(second).getByRole('heading', { name: 'Guide', exact: true }).waitFor();
  assert.match((await state()).docs[(await state()).groups.find(g => g.id === second).active].language, /^markdown$/);
  await action('documents', 'showDocument', id, { group: second });
  await group(second).getByRole('link', { name: 'Missing', exact: true }).click();
  await page.locator('.notification').waitFor();
  await open('empty.md'); await mode(second, 'Markdown Preview');
  assert.equal(await group(second).locator('.markdown-body').innerText(), '');
  await open('ordinary.txt'); assert.equal(await group(second).getByRole('button', { name: 'Select Markdown editor' }).count(), 0);
  await open('icon.svg'); await group(second).locator('.image-stage img').waitFor();
  await group(second).getByRole('button', { name: 'Select SVG editor' }).click(); await page.getByRole('menuitem', { name: 'Text Editor', exact: true }).click();
  await group(second).locator('.monaco-host').waitFor({ state: 'visible' });
  await group(second).getByRole('button', { name: 'Select SVG editor' }).click(); await page.getByRole('menuitem', { name: 'Image Preview', exact: true }).click();
  await group(second).locator('.image-stage img').waitFor();
  checks.push('Relative file links with fragments, .markdown extension, missing-file notification, empty document, plain text and SVG regression');
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ checks, errors, log }, null, 2));
  console.log(JSON.stringify({ run, checks, errors }, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  console.error(log); throw error;
} finally {
  await browser?.close().catch(() => {}); child.kill(); images.close();
}
