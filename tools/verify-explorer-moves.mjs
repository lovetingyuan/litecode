import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real tree, Worker, Monaco and mouse drags; only the disk IPC is substituted.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(60000);
const root = 'C:/move-fixture';
const initialPaths = ['source/a.txt', 'source/b.txt', 'source/folder/deep.txt', 'target/', 'other/a.txt', 'root.txt'];
const output = '.verification/explorer-moves';
const urls = {};
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => {
  const name = new URL(request.url()).pathname.match(/^\/src\/(documents|store)\.tsx?$/)?.[1];
  if (name && !urls[name]) urls[name] = request.url();
});
await page.addInitScript(({ paths, root }) => {
  window.moveFixture = { paths, root, calls: [], executionDelay: 0, scanDelay: 0, failAfter: null };
}, { paths: initialPaths, root });
await page.route('**/src/bridge.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const desktop = false;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() { return { root: ${JSON.stringify(root)}, documents: [], session: {}, recent: [], settings: {}, keybindings: [], warnings: [], dataDir: '' }; }
function plan(args) {
  const f = window.moveFixture;
  const moves = args.sources.map(from => ({ from, to: args.targetDirectory + '/' + from.split('/').pop() })).filter(m => m.from !== m.to);
  const destinations = new Set();
  for (const m of moves) {
    const path = m.to.slice(f.root.length + 1);
    if (destinations.has(path.toLowerCase()) || f.paths.some(p => p.replace(/\\/$/, '').toLowerCase() === path.toLowerCase())) throw { code: 'exists', message: 'Nothing was moved. Destination already exists: ' + path };
    destinations.add(path.toLowerCase());
  }
  return moves;
}
export async function call(command, args) {
  const f = window.moveFixture;
  f.calls.push({ command, args });
  if (command === 'scan_workspace') { await new Promise(resolve => setTimeout(resolve, f.scanDelay)); return { paths: [...f.paths], git: [], branch: null, warnings: [], truncated: false }; }
  if (command === 'read_document') return { path: args.path, text: args.path + ' content', encoding: 'utf8', eol: 'LF', revision: 'fixture' };
  if (command === 'plan_file_moves') return plan(args);
  if (command === 'move_files') {
    await new Promise(resolve => setTimeout(resolve, f.executionDelay));
    const moves = plan(args), moved = [], failed = [];
    for (const m of moves) {
      if (f.failAfter !== null && moved.length >= f.failAfter) { failed.push({ path: m.from, message: 'Injected I/O failure' }); break; }
      const from = m.from.slice(f.root.length + 1), to = m.to.slice(f.root.length + 1);
      const directory = f.paths.includes(from + '/') || f.paths.some(p => p.startsWith(from + '/'));
      if (from.includes('/')) { const parent = from.slice(0, from.lastIndexOf('/') + 1); if (!f.paths.includes(parent)) f.paths.push(parent); }
      f.paths = f.paths.map(p => p === from || (directory && p.startsWith(from + '/')) ? to + p.slice(from.length) : p);
      moved.push(m);
    }
    return { moved, failed };
  }
  if (command === 'save_document') return 'saved';
  throw new Error('Unexpected fixture command: ' + command);
}
` }));

const tree = page.locator('file-tree-container');
const row = path => tree.locator(`[data-item-path="${path}"]`).first();
const dialog = page.getByRole('dialog');
const selected = () => tree.locator('[aria-selected="true"]').evaluateAll(rows => rows.map(r => r.dataset.itemPath));
const executions = () => page.evaluate(() => window.moveFixture.calls.filter(c => c.command === 'move_files').length);
async function moduleCall(module, name, ...args) {
  return page.evaluate(async ({ url, name, args }) => (await import(url))[name](...args), { url: urls[module], name, args });
}
async function fixture(paths = initialPaths) {
  await page.reload();
  await row('root.txt').waitFor();
  if (paths !== initialPaths) {
    await page.evaluate(paths => { window.moveFixture.paths = paths; }, paths);
    await moduleCall('store', 'setApp', { treeRoot: root, tree: { paths, git: [], branch: null, warnings: [], truncated: false } });
  }
}
async function beginDrag(from) {
  await row(from).hover();
  const box = await row(from).boundingBox();
  const x = box.x + Math.min(100, box.width / 2), y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y + 2, { steps: 6 });
}
async function over(target) {
  const box = await target.boundingBox();
  await page.mouse.move(box.x + Math.min(100, box.width / 2), box.y + box.height / 2, { steps: 10 });
  await page.mouse.move(box.x + Math.min(100, box.width / 2) + 1, box.y + box.height / 2);
}
async function drop(from, target) { await beginDrag(from); await over(target); await page.mouse.up(); }
async function multiSelect(paths) {
  await row(paths[0]).click();
  for (const path of paths.slice(1)) await row(path).click({ modifiers: ['Control'] });
}
async function noDialog() { assert.equal(await dialog.count(), 0); }
async function confirm() { await dialog.waitFor(); await dialog.getByRole('button', { name: 'Move', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); }

try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? 'http://localhost:1421');
  await row('root.txt').waitFor();
  await row('source/').click();
  await multiSelect(['source/a.txt', 'source/b.txt']);
  await beginDrag('source/a.txt');
  assert.equal(await tree.locator('[data-file-tree-drag-count]').textContent(), '2');
  await over(row('target/'));
  assert.equal(await row('target/').getAttribute('data-item-drag-target'), 'true');
  await page.mouse.up();
  await dialog.waitFor();
  assert.equal(await executions(), 0, 'No disk writes before confirmation');
  assert.deepEqual(await selected(), ['source/a.txt', 'source/b.txt']);
  assert.equal(await row('target/a.txt').count(), 0, 'The tree has not optimistically moved');
  assert.match(await dialog.textContent(), /following 2 files and folders.*target/s);
  await page.screenshot({ path: `${output}/confirmation.png` });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await executions(), 0);
  assert.deepEqual(await selected(), ['source/a.txt', 'source/b.txt']);
  console.log('PASS: actual multi-select mouse drag, count badge, target highlight, confirmation before mutation, cancel retains selection');

  for (const cancel of ['escape', 'close', 'backdrop']) {
    await drop('source/a.txt', row('target/'));
    await dialog.waitFor();
    if (cancel === 'escape') await page.keyboard.press('Escape');
    if (cancel === 'close') await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    if (cancel === 'backdrop') await page.mouse.click(4, 100);
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await executions(), 0);
    assert.deepEqual(await selected(), ['source/a.txt', 'source/b.txt']);
  }
  console.log('PASS: Esc, close and backdrop cancel without moving');

  // Open and edit a buffer, then move it in a multiple selection.
  const id = await moduleCall('documents', 'openPath', `${root}/source/a.txt`, { pinned: true });
  await page.evaluate(async ({ url, id }) => { const m = (await import(url)).models.get(id); m.setValue('unsaved edit'); }, { url: urls.documents, id });
  await multiSelect(['source/a.txt', 'source/b.txt']);
  await drop('source/a.txt', row('target/'));
  await dialog.waitFor();
  await page.keyboard.press('Enter');
  await row('target/a.txt').waitFor();
  await page.waitForFunction(() => document.querySelector('file-tree-container')?.shadowRoot?.querySelectorAll('[aria-selected="true"]').length === 2);
  assert.deepEqual(await selected(), ['target/a.txt', 'target/b.txt']);
  const doc = await page.evaluate(async ({ store, documents, id }) => ({ doc: (await import(store)).useApp.getState().docs[id], text: (await import(documents)).models.get(id).getValue() }), { store: urls.store, documents: urls.documents, id });
  assert.equal(doc.doc.path, `${root}/target/a.txt`);
  assert.equal(doc.doc.dirty, true);
  assert.equal(doc.text, 'unsaved edit');
  await moduleCall('documents', 'save', id);
  assert.equal(await page.evaluate(() => window.moveFixture.calls.filter(c => c.command === 'save_document').at(-1).args.path), `${root}/target/a.txt`);
  await page.screenshot({ path: `${output}/moved-dirty-buffer.png` });
  console.log('PASS: Enter moves the selection and rebinds a dirty editor; subsequent save uses the destination');

  await page.evaluate(async ({ url, id }) => {
    const d = await import(url);
    const first = d.save(id), second = d.save(id);
    const barrier = d.beginDocumentMove([window.moveFixture.root + '/target/a.txt']);
    await Promise.all([first, second]);
    const release = await barrier;
    release();
  }, { url: urls.documents, id });
  console.log('PASS: starting a move drains multiple queued saves without deadlocking');

  await fixture();
  await row('source/').click();
  const movingId = await moduleCall('documents', 'openPath', `${root}/source/a.txt`, { pinned: true });
  await page.evaluate(async ({ url, id }) => {
    window.moveFixture.executionDelay = 300;
    (await import(url)).models.get(id).setValue('edit during move');
  }, { url: urls.documents, id: movingId });
  await drop('source/a.txt', row('target/'));
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await page.waitForFunction(() => window.moveFixture.calls.some(c => c.command === 'move_files'));
  await moduleCall('documents', 'save', movingId);
  assert.equal(await page.evaluate(() => window.moveFixture.calls.filter(c => c.command === 'save_document').at(-1).args.path), `${root}/target/a.txt`);
  await row('target/a.txt').waitFor();
  console.log('PASS: saves requested during disk movement wait and use the new path');

  await fixture();
  await row('source/').click();
  await multiSelect(['source/a.txt', 'source/b.txt']);
  await page.evaluate(() => { window.moveFixture.failAfter = 1; });
  await drop('source/a.txt', row('target/'));
  await confirm();
  await row('target/a.txt').waitFor();
  await row('source/b.txt').waitFor();
  await page.getByText(/Injected I\/O failure/).waitFor();
  assert.equal(await row('target/b.txt').count(), 0);
  console.log('PASS: partial disk failure updates only completed moves');

  await fixture();
  await row('source/').click();
  await drop('source/a.txt', row('target/'));
  await dialog.waitFor();
  await page.evaluate(() => { window.moveFixture.paths.push('target/a.txt'); });
  await confirm();
  await page.getByText(/Nothing was moved/).waitFor();
  assert.ok((await page.evaluate(() => window.moveFixture.paths)).includes('source/a.txt'));
  console.log('PASS: a destination created while confirming blocks the batch on revalidation');

  await fixture();
  await row('source/').click();
  await multiSelect(['source/a.txt', 'source/b.txt']);
  await drop('root.txt', row('target/'));
  await dialog.waitFor();
  assert.equal(await dialog.locator('.move-items li').count(), 1, 'Unselected source drags alone');
  await confirm();
  await row('target/root.txt').waitFor();
  console.log('PASS: dragging an unselected row carries only that row');

  await fixture();
  await row('source/').click();
  await row('source/a.txt').click();
  await row('source/b.txt').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), ['source/a.txt', 'source/b.txt']);
  await drop('source/a.txt', row('source/b.txt'));
  await noDialog();
  assert.equal(await executions(), 0);
  await drop('source/', row('source/folder/'));
  await noDialog();
  console.log('PASS: Shift range selection, same-directory no-op and descendant drop rejection');

  if (await row('source/folder/').getAttribute('aria-expanded') !== 'true') await row('source/folder/').click();
  await multiSelect(['source/a.txt', 'source/folder/deep.txt', 'source/folder/']);
  await drop('source/folder/', row('target/'));
  await dialog.waitFor();
  assert.equal(await dialog.locator('.move-items li').count(), 2);
  await confirm();
  await row('target/folder/').waitFor();
  await drop('target/a.txt', page.locator('.section-heading').filter({ hasText: 'MOVE-FIXTURE' }));
  await confirm();
  await row('a.txt').waitFor();
  console.log('PASS: selected parent/child deduplication, mixed moves and workspace-title root drop');

  await fixture();
  await row('source/').click();
  await row('other/').click();
  await multiSelect(['source/a.txt', 'other/a.txt']);
  await drop('source/a.txt', row('target/'));
  await page.getByText(/Nothing was moved/).waitFor();
  await noDialog();
  assert.equal(await executions(), 0);
  console.log('PASS: batch-name conflicts are rejected before confirmation');

  await fixture();
  await row('source/').click();
  await drop('source/a.txt', row('target/'));
  await dialog.waitFor();
  await moduleCall('store', 'setApp', { root: 'C:/another-workspace' });
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await executions(), 0);
  console.log('PASS: workspace change cancels an outstanding move confirmation');

  await fixture();
  await row('source/').click();
  await beginDrag('source/a.txt');
  await over(row('source/folder/'));
  await page.waitForTimeout(950);
  assert.equal(await row('source/folder/').getAttribute('aria-expanded'), 'true');
  await page.mouse.up();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS: collapsed folders expand after hover during a real drag');

  await fixture();
  await row('source/').click();
  await drop('source/a.txt', tree);
  // tree's center is blank space with this short fixture.
  await confirm();
  await row('a.txt').waitFor();
  console.log('PASS: blank tree space moves to the workspace root');

  await fixture([...initialPaths, ...Array.from({ length: 130 }, (_, i) => `z-${String(i).padStart(3, '0')}.txt`)]);
  await row('source/').click();
  await beginDrag('source/a.txt');
  const bounds = await tree.boundingBox();
  await page.mouse.move(bounds.x + 100, bounds.y + bounds.height - 4, { steps: 12 });
  await page.waitForTimeout(700);
  assert.ok(await tree.evaluate(host => host.shadowRoot.querySelector('[data-file-tree-virtualized-scroll]').scrollTop) > 100);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  console.log('PASS: edge auto-scroll during a real drag');
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
