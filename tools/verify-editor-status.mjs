import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real status bar, Quick Access and Monaco; only the native bridge is isolated.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15_000);
const urls = {}, errors = [];
const id = 'file:///C:/status-fixture/sample.txt';
const doc = { id, path: 'C:/status-fixture/sample.txt', name: 'sample.txt', language: 'plaintext', text: 'one\ntwo\nthree', encoding: 'utf8', eol: 'LF', revision: 'fixture', dirty: false, version: 1 };
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => {
  const match = new URL(request.url()).pathname.match(/^\/src\/(store|documents)\.ts$/);
  if (match) {urls[match[1]] = request.url();}
});
await page.route('**/src/bridge.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() { return {root:null,documents:[${JSON.stringify(doc)}],session:{groups:[{id:'one',tabs:[${JSON.stringify(id)}],active:${JSON.stringify(id)},preview:null,views:{}}],activeGroup:'one'},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command) {
 if (command === 'inspect_file') return {kind:'text',size:13,stamp:'fixture'};
 if (command === 'read_document' || command === 'language_document') return ${JSON.stringify(doc)};
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const status = page.locator('.status-right');
const input = page.getByRole('combobox');
const closed = () => page.locator('.quick-open').waitFor({ state: 'hidden' });
const focused = () => page.waitForFunction(() => !!document.activeElement?.closest('.monaco-editor'));
async function filter(value) {
  await input.fill(value);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function read() {
  return page.evaluate(async ({ urls, id }) => {
    const { useApp } = await import(urls.store); const { models, editor } = await import(urls.documents);
    const state = useApp.getState(); const model = models.get(id);
    return { doc: state.docs[id], size: state.settings['editor.tabSize'] ?? 4, modelSize: model.getOptions().tabSize,
      eol: model.getEOL(), language: model.getLanguageId(), position: editor().getPosition() };
  }, { urls, id });
}
async function open(button, title) {
  await status.getByRole('button', { name: button, exact: typeof button === 'string' }).click();
  await page.getByRole('combobox', { name: title, exact: true }).waitFor();
  assert.equal(await input.evaluate(el => el === document.activeElement), true, 'The filter receives focus');
  assert.equal(await page.locator('.modal-panel').count(), 0, 'No centered dialog appears');
  const bounds = await page.locator('.quick-open').boundingBox();
  assert.equal(bounds.y, 38, 'All status pickers use the same top position');
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 640) <= 1, 'The picker is centered horizontally');
}
async function cancel() { await input.press('Escape'); await closed(); await focused(); }
try {
  await mkdir('.verification/editor-status', { recursive: true });
  await page.goto('http://localhost:1420');
  await status.getByRole('button', { name: 'Plain Text', exact: true }).waitFor();

  await open(/^Ln /, 'Quick Access');
  await input.fill(':2,2'); await input.press('Enter'); await closed(); await focused();
  assert.deepEqual((await read()).position, { lineNumber: 2, column: 2 });

  await open('Spaces: 4', 'Select Tab Size');
  assert.equal(await page.getByRole('option').count(), 16);
  assert.equal(await page.locator('.quick-item[aria-selected="true"] .quick-label').textContent(), '4');
  await page.screenshot({ path: '.verification/editor-status/indent.png' });
  await input.press('ArrowDown'); await input.press('Enter'); await closed();
  await page.waitForFunction(() => document.querySelector('.status-right')?.textContent.includes('Spaces: 5'));
  await page.waitForFunction(async ({ url, id }) => (await import(url)).models.get(id).getOptions().tabSize === 5, { url: urls.documents, id }, { timeout: 3000 });
  assert.equal((await read()).modelSize, 5);
  await open('Spaces: 5', 'Select Tab Size');
  await input.fill('999'); await input.press('Enter');
  assert.equal(await page.getByRole('option').count(), 0);
  await cancel(); assert.equal((await read()).size, 5);

  await open('UTF-8', 'Select File Encoding');
  assert.equal(await page.getByRole('option').count(), 5);
  await input.press('Enter'); await closed();
  assert.equal((await read()).doc.dirty, false, 'Selecting the current encoding keeps the clean state');
  await open('UTF-8', 'Select File Encoding');
  await input.fill('gbk'); await cancel();
  assert.equal((await read()).doc.encoding, 'utf8', 'Escape cancels encoding changes');
  await open('UTF-8', 'Select File Encoding');
  await page.screenshot({ path: '.verification/editor-status/encoding.png' });
  await input.fill('gbk'); await page.getByRole('option').click(); await closed(); await focused();
  assert.equal((await read()).doc.encoding, 'gbk');
  assert.equal((await read()).doc.dirty, true, 'Encoding changes remain pending for the next save');

  await open('LF', 'Select End of Line Sequence');
  assert.equal((await read()).eol, '\n', 'Opening the EOL picker does not change the file');
  await page.screenshot({ path: '.verification/editor-status/eol.png' });
  await input.press('ArrowDown'); await input.press('Enter'); await closed(); await focused();
  assert.equal((await read()).eol, '\r\n'); assert.equal((await read()).doc.eol, 'CRLF');
  await page.keyboard.press('Control+z');
  assert.equal((await read()).eol, '\n', 'EOL changes remain undoable');

  await open('Plain Text', 'Select Language Mode');
  await filter('typescriptreact');
  assert.equal(await page.locator('.quick-label').textContent(), 'TSX', 'Languages can be filtered by identifier');
  await cancel(); assert.equal((await read()).language, 'plaintext');
  await open('Plain Text', 'Select Language Mode');
  await filter('python'); await page.screenshot({ path: '.verification/editor-status/language.png' });
  await input.press('Enter'); await closed();
  await status.getByRole('button', { name: 'python', exact: true }).waitFor();
  assert.equal((await read()).language, 'python');

  // Entering the picker from the command palette must reset its filter and focus.
  await page.keyboard.press('Control+Shift+p'); await input.fill('>Change Language Mode'); await input.press('Enter');
  await page.getByRole('combobox', { name: 'Select Language Mode', exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  await input.fill('plain'); await input.press('Enter'); await closed();
  await status.getByRole('button', { name: 'Plain Text', exact: true }).waitFor();

  const before = await read();
  await open('Spaces: 5', 'Select Tab Size');
  await page.locator('.quick-backdrop').click({ position: { x: 10, y: 600 } }); await closed(); await focused();
  assert.deepEqual(await read(), before, 'Clicking outside cancels without changing document state');
  assert.deepEqual(errors, []);
  console.log('PASS: all five text status controls share the top Quick Access popup; filtering, current choices, keyboard/mouse selection, cancellation, focus restoration, encoding state, EOL undo and command palette handoff work');
} catch (error) {
  await page.screenshot({ path: '.verification/editor-status/failure.png' });
  throw error;
} finally { await browser.close(); }
