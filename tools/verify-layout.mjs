import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real Allotment, Monaco and previews; IPC is isolated, like verify-editor-tabs.
const browser = await chromium.launch({ channel: 'msedge', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15_000);
const urls = {}, errors = [];
const docs = ['long.txt', 'README.md', 'image.png'].map((name, i) => ({ id: `file:///C:/layout/${name}`, path: `C:/layout/${name}`, name, language: i === 1 ? 'markdown' : 'plaintext', text: i === 1 ? '# Preview\n\n' + 'Paragraph\n\n'.repeat(150) : 'line contents\n'.repeat(300), encoding: 'utf8', eol: 'LF', revision: 'fixture', dirty: false, version: 1, kind: i === 2 ? 'image' : 'text', ...(i === 2 ? { fileInfo: { kind: 'image', size: 100, stamp: 'fixture' } } : {}) }));
let restored;
page.on('request', request => {
  const match = new URL(request.url()).pathname.match(/^\/src\/(documents|commands|store)\.ts$/);
  if (match) {urls[match[1]] = request.url();}
});
page.on('pageerror', error => errors.push(String(error)));
await page.route('**/src/bridge.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const desktop = false;
export const mediaSource = () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="blue"/></svg>') + '#fixture';
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() { return {root:'C:/layout',documents:${JSON.stringify(docs)},session:${JSON.stringify(restored ?? { groups: [{ id: 'one', tabs: docs.map(d => d.id), active: docs[0].id, preview: null, views: {} }], activeGroup: 'one' })},recent:[],settings:{'files.autoSave':'off'},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command) {
 if (command === 'scan_workspace') return {paths:${JSON.stringify(docs.map(d => d.name))},git:[],branch:null,warnings:[],truncated:false};
 if (command === 'inspect_file') return {kind:'text',size:30,stamp:'fixture'};
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const action = (module, name, ...args) => page.evaluate(async ({ url, name, args }) => (await import(url))[name](...args), { url: urls[module], name, args });
const state = () => action('documents', 'session');
const group = id => page.locator(`[data-group-id="${id}"]`);
const boxes = () => page.locator('.editor-group').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { id: el.dataset.groupId, x: r.x, y: r.y, width: r.width, height: r.height }; }));
const near = (a, b, tolerance = 3) => assert.ok(Math.abs(a - b) <= tolerance, `${a} should be near ${b}`);
async function count(n) { await page.waitForFunction(n => document.querySelectorAll('.editor-group').length === n, n); }
async function reset() { restored = undefined; await page.goto('http://localhost:1420'); await group('one').waitFor(); }
async function split(id, direction) { const result = await action('documents', 'splitGroup', id, undefined, direction); await group(result).waitFor(); return result; }
async function drag(separator, dx, dy = 0) {
  const r = await separator.boundingBox(); assert.ok(r);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down(); await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 12 }); await page.mouse.up();
}
const sashes = () => page.locator('.editor-groups .sash');
try {
  await mkdir('.verification/layout', { recursive: true });
  await reset();
  await group('one').getByRole('tab', { name: 'image.png', exact: true }).click();
  await page.locator('.media-loading').waitFor({ state: 'hidden' });
  const imageViewport = group('one').locator('.image-viewport');
  async function imageOverflow() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return imageViewport.evaluate(el => ({ horizontal: el.scrollWidth > el.clientWidth, vertical: el.scrollHeight > el.clientHeight }));
  }
  for (const zoom of [1, 1.25, 1.4, 1.75]) {
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
    assert.deepEqual(await imageOverflow(), { horizontal: false, vertical: false }, `Small image fits at UI zoom ${zoom}`);
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1.4'; });
  await action('documents', 'patchMediaView', 'one', docs[2].id, { scale: 2 });
  assert.deepEqual(await imageOverflow(), { horizontal: true, vertical: false }, 'Wide image only scrolls horizontally');
  await action('documents', 'patchMediaView', 'one', docs[2].id, { scale: 10 });
  assert.deepEqual(await imageOverflow(), { horizontal: true, vertical: true }, 'Large zoom keeps both scrollbars');
  await imageViewport.evaluate(el => el.scrollTo(180, 120));
  await group('one').getByRole('tab', { name: 'long.txt', exact: true }).click();
  await group('one').getByRole('tab', { name: 'image.png', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.image-viewport')?.scrollTop === 120);
  assert.equal(await imageViewport.evaluate(el => el.scrollLeft), 180);
  await action('documents', 'patchMediaView', 'one', docs[2].id, { scale: 'fit' });
  assert.deepEqual(await imageOverflow(), { horizontal: false, vertical: false }, 'Fit clears scrollbars after zooming out');
  await page.setViewportSize({ width: 700, height: 500 });
  assert.deepEqual(await imageOverflow(), { horizontal: false, vertical: false }, 'Large image fits a smaller fractional viewport');
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('PASS: image scrollbars reflect actual overflow at fractional UI scales, zoom, tab restore and resize');

  await reset();
  const right = await split('one', 'right'); const third = await split(right, 'right'); await count(3);
  let b = await boxes(); near(b[0].width, b[1].width); near(b[1].width, b[2].width);
  assert.deepEqual((await state()).editorLayout.children.map(n => n.id), ['one', right, third]);
  await drag(sashes().nth(0), 90);
  b = await boxes(); const untouched = b[2].width, original = b[0].width;
  await split('one', 'left'); await count(4);
  b = await boxes(); near(b[0].width, original / 2); near(b[1].width, original / 2); near(b[3].width, untouched);
  await drag(sashes().nth(0), 25);
  const preserved = (await boxes()).slice(2).map(r => r.width);
  await sashes().nth(0).dblclick(); b = await boxes(); near(b[0].width, b[1].width); b.slice(2).forEach((r, i) => near(r.width, preserved[i]));
  console.log('PASS: three equal columns, local split after resizing, and double-click balances only its adjacent pair');

  await reset();
  const second = await split('one', 'right'); const below = await split(second, 'down'); const above = await split('one', 'up'); await count(4);
  b = await boxes();
  assert.ok(b.find(r => r.id === above).y < b.find(r => r.id === 'one').y);
  assert.ok(b.find(r => r.id === below).y > b.find(r => r.id === second).y);
  const horizontal = page.locator('.editor-groups .sash-horizontal').last();
  const beforeHeight = (await group(second).boundingBox()).height;
  await drag(horizontal, 0, 65); assert.ok((await group(second).boundingBox()).height > beforeHeight + 40);
  await horizontal.dblclick(); near((await group(second).boundingBox()).height, (await group(below).boundingBox()).height);
  await horizontal.focus(); await horizontal.press('ArrowDown');
  assert.ok((await group(second).boundingBox()).height > (await group(below).boundingBox()).height + 10);
  await page.screenshot({ path: '.verification/layout/01-nested.png' });
  console.log('PASS: mixed four-way grid, vertical dragging, pair reset and keyboard resize');

  for (const focused of [below, above, second, 'one']) {
    await group(focused).locator('.monaco-host').click({ position: { x: 160, y: 50 } });
    await page.waitForFunction(id => document.querySelector('.editor-group.focused')?.dataset.groupId === id, focused);
    await page.mouse.move(1, 1);
    const screenshot = await page.screenshot();
    const indicators = await page.evaluate(async data => {
      const image = new Image(); image.src = data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return [...document.querySelectorAll('.editor-group')].map(group => {
        const tab = group.querySelector('.editor-tab.active'); const r = tab.getBoundingClientRect();
        const pixels = context.getImageData(Math.ceil(r.x + 12), Math.floor(r.y), 8, 3).data;
        let blue = false;
        for (let i = 0; i < pixels.length; i += 4) {if (pixels[i] === 0 && pixels[i + 1] === 120 && pixels[i + 2] === 212) {blue = true;}}
        return { id: group.dataset.groupId, blue };
      });
    }, `data:image/png;base64,${screenshot.toString('base64')}`);
    assert.equal(indicators.find(i => i.id === focused).blue, true, 'The focused tab border is visible above the Allotment separator');
    assert.deepEqual(indicators.filter(i => i.blue).map(i => i.id), [focused], 'Only the focused group has a blue tab border');
  }
  await page.screenshot({ path: '.verification/layout/03-tab-focus.png' });
  console.log('PASS: visible tab focus indicator follows all four groups, including lower nested panes');

  const sidebar = page.getByRole('separator', { name: 'Primary side bar width' });
  await sidebar.focus(); const oldWidth = (await state()).sidebarWidth; await sidebar.press('ArrowRight'); near((await state()).sidebarWidth, oldWidth + 10);
  await drag(sidebar, 35); const width = (await state()).sidebarWidth;
  const ratio = (await state()).editorLayout.sizes[0] / (await state()).editorLayout.sizes[1];
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForFunction(width => document.querySelector('.workbench-layout').clientWidth > width, 1450);
  near((await state()).sidebarWidth, width);
  const resized = (await state()).editorLayout.sizes; near(resized[0] / resized[1], ratio, .02);
  await action('commands', 'execute', 'workbench.action.toggleSidebarVisibility');
  assert.equal((await state()).sidebar, '');
  await action('commands', 'execute', 'workbench.action.toggleSidebarVisibility'); near((await state()).sidebarWidth, width);
  console.log('PASS: side bar drag, keyboard, visibility and fixed width during proportional editor resizing');

  await reset();
  await page.evaluate(async url => {
    const { editors } = await import(url); const editor = editors.get('one'), model = editor.getModel();
    model.pushEditOperations([], [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'unsaved ' }], () => null);
    editor.setPosition({ lineNumber: 140, column: 5 }); editor.revealLineInCenter(140); editor.setScrollTop(2500);
    window.__view = { position: editor.getPosition(), scroll: editor.getScrollTop(), text: model.getValue() };
  }, urls.documents);
  const copy = await split('one', 'right');
  await page.waitForFunction(async url => { const { editors } = await import(url); return editors.get('one')?.getScrollTop() > 2000; }, urls.documents);
  const views = await page.evaluate(async ({ url, copy }) => {
    const { editors } = await import(url); const source = editors.get('one'), target = editors.get(copy);
    return { source: source.getPosition(), target: target.getPosition(), scroll: source.getScrollTop(), shared: source.getModel() === target.getModel(), text: target.getModel().getValue(), expected: window.__view };
  }, { url: urls.documents, copy });
  assert.deepEqual(views.source, views.expected.position); assert.deepEqual(views.target, views.expected.position); near(views.scroll, views.expected.scroll); assert.equal(views.shared, true); assert.equal(views.text, views.expected.text);
  await group(copy).getByRole('tab', { name: 'long.txt, unsaved', exact: true }).waitFor();
  const undone = await page.evaluate(async ({ url, copy }) => {
    const { editors } = await import(url); const model = editors.get(copy).getModel();
    await model.undo(); const text = editors.get('one').getModel().getValue(); await model.redo(); return text;
  }, { url: urls.documents, copy });
  assert.equal(undone.startsWith('unsaved '), false);
  await group('one').getByRole('tab', { name: 'README.md', exact: true }).click();
  await action('documents', 'patchMediaView', 'one', docs[1].id, { mode: 'markdown' });
  await group('one').locator('.markdown-preview').waitFor();
  await group('one').locator('.markdown-preview').evaluate(el => { el.scrollTop = 180; });
  await page.waitForFunction(async url => (await import(url)).useApp.getState().groups.find(g => g.id === 'one').mediaViews?.['file:///C:/layout/README.md']?.scrollTop === 180, urls.store);
  const previewCopy = await split('one', 'down'); await group(previewCopy).locator('.markdown-preview').waitFor();
  await page.waitForFunction(id => document.querySelector(`[data-group-id="${id}"] .markdown-preview`)?.scrollTop === 180, previewCopy);
  near(await group(previewCopy).locator('.markdown-preview').evaluate(el => el.scrollTop), 180);
  await group('one').getByRole('tab', { name: 'image.png', exact: true }).click(); await group('one').locator('img').waitFor();
  const imageCopy = await split('one', 'left'); await group(imageCopy).locator('img').waitFor();
  assert.equal(await group(imageCopy).locator('img').evaluate(el => el.complete && el.naturalWidth > 0), true);
  console.log('PASS: shared unsaved model, view preservation, independent Markdown and image previews across nested splits');

  restored = await state(); const savedLayout = restored.editorLayout; const savedActive = restored.activeGroup;
  restored.sidebar = '';
  await page.reload(); await group(savedActive).waitFor(); await count(restored.groups.length);
  assert.equal((await state()).sidebar, ''); assert.equal((await state()).activeGroup, savedActive);
  assert.deepEqual((await state()).groupMru, restored.groupMru);
  const shape = node => node.type === 'group' ? node.id : { axis: node.axis, children: node.children.map(shape) };
  assert.deepEqual(shape((await state()).editorLayout), shape(savedLayout));
  const proportions = (actual, saved) => {
    if (actual.type === 'group') {return;}
    const a = actual.sizes.reduce((x, y) => x + y), b = saved.sizes.reduce((x, y) => x + y);
    actual.sizes.forEach((size, i) => near(size / a, saved.sizes[i] / b, .02));
    actual.children.forEach((node, i) => proportions(node, saved.children[i]));
  };
  proportions((await state()).editorLayout, savedLayout);
  await page.screenshot({ path: '.verification/layout/02-restored.png' });
  console.log('PASS: nested session restoration, MRU, active group and hidden side bar');

  await reset();
  const recent = await split('one', 'right'); const closing = await split(recent, 'down');
  await action('store', 'setApp', { activeGroup: 'one' });
  await action('store', 'setApp', { activeGroup: recent });
  await action('store', 'setApp', { activeGroup: closing });
  await action('documents', 'closeDocument', docs[0].id, closing); await count(2);
  assert.equal((await state()).activeGroup, recent);
  await page.waitForFunction(id => document.querySelector(`[data-group-id="${id}"]`)?.contains(document.activeElement), recent);
  await action('documents', 'closeGroup', 'one'); await count(1);
  assert.equal((await state()).activeGroup, recent);
  await page.waitForFunction(id => document.querySelector(`[data-group-id="${id}"]`)?.contains(document.activeElement), recent);
  assert.equal((await state()).groups[0].tabs.length, 3);
  console.log('PASS: closing groups restores MRU focus, merges tabs and retains the last group');

  await reset();
  await action('store', 'setApp', { settings: { 'workbench.editor.openSideBySideDirection': 'down' } });
  await group('one').locator('.monaco-host').click(); await page.keyboard.press('Control+Backslash'); await count(2);
  assert.equal((await state()).editorLayout.axis, 'vertical');
  await group('one').getByRole('tab', { name: 'README.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Split Left', exact: true }).click(); await count(3);
  const active = (await state()).activeGroup;
  assert.equal((await state()).groups.find(g => g.id === active).active, docs[1].id);
  await group(active).getByRole('button', { name: 'Split Editor Direction', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Split Up', exact: true }).click(); await count(4);
  console.log('PASS: Ctrl+Backslash respects direction setting; context and toolbar menus target the correct group');
  assert.deepEqual(errors, []);
  console.log('PASS: no browser page errors');
} catch (error) {
  console.error(await page.locator('.markdown-preview, .image-viewport').evaluateAll(elements => elements.map(el => ({ group: el.closest('[data-group-id]').dataset.groupId, height: el.clientHeight, scrollHeight: el.scrollHeight, top: el.scrollTop }))));
  console.error((await state()).groups.map(g => ({ id: g.id, mediaViews: g.mediaViews })));
  await page.screenshot({ path: '.verification/layout/failure.png' });
  throw error;
} finally { await browser.close(); }
