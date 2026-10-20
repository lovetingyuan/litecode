import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Run against npm run dev. Exercise real menus, Monaco and Trees with isolated IPC.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15_000);
const files = ['a.txt', 'b.txt', 'nested/c.txt', 'd.txt'];
const docs = files.map(name => ({ id: `file:///C:/tab-fixture/${name}`, path: `C:/tab-fixture/${name}`, name: name.split('/').at(-1), language: 'plaintext', text: `${name} content`, encoding: 'utf8', eol: 'LF', revision: 'fixture', dirty: false, version: 1 }));
const urls = {};
const errors = [];
let restored;
page.on('request', request => {
  const match = new URL(request.url()).pathname.match(/^\/src\/(documents|commands|store)\.ts$/);
  if (match) {urls[match[1]] = request.url();}
});
page.on('pageerror', error => errors.push(String(error)));
await page.addInitScript(() => {
  window.__copied = '';
  window.__revealed = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } });
});
await page.route('**/src/bridge.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() {
 return {root:'C:/tab-fixture',documents:${JSON.stringify(docs)},session:${JSON.stringify(restored ?? { groups: [{ id: 'one', tabs: docs.map(d => d.id), active: docs[1].id, preview: null, views: {} }], activeGroup: 'one' })},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''};
}
export async function call(command, args) {
 if(command === 'inspect_file') return {kind:'text',size:20,stamp:'fixture'};
 if(command === 'scan_workspace') return {paths:${JSON.stringify(['nested/', ...files])},git:[],branch:null,warnings:[],truncated:false};
 if(command === 'read_document') return {text:args.path+' content',encoding:'utf8',eol:'LF',revision:'fixture'};
 if(command === 'reveal_path') { window.__revealed.push(args.path); return; }
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const menu = page.locator('.editor-tab-menu');
const tab = (name, group = 0) => page.locator('.editor-tabs').nth(group).getByRole('tab', { name, exact: true });
const item = name => menu.getByRole('menuitem', { name, exact: true });
async function moduleAction(module, action, ...args) {
  return page.evaluate(async ({ url, action, args }) => (await import(url))[action](...args), { url: urls[module], action, args });
}
const documentAction = (action, ...args) => moduleAction('documents', action, ...args);
async function state() { return page.evaluate(async url => { const s = (await import(url)).useApp.getState(); return { groups: s.groups, activeGroup: s.activeGroup, docs: s.docs }; }, urls.store); }
async function reset() {
  restored = undefined;
  await page.goto('http://localhost:1420');
  await tab('b.txt').waitFor();
}
async function context(name, group = 0) {
  await tab(name, group).click({ button: 'right' });
  await menu.waitFor();
}
async function choose(name) {
  await item(name).click();
  await menu.waitFor({ state: 'hidden' });
}
async function chord(first, second) {
  await page.keyboard.press(first); await page.keyboard.press(second);
}
try {
  await mkdir('.verification/editor-tabs', { recursive: true });
  await reset();
  await context('a.txt');
  assert.deepEqual(await menu.getByRole('menuitem').locator('span').allTextContents(), ['Close', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All', 'Copy Path', 'Copy Relative Path', 'Reveal in File Explorer', 'Reveal in Explorer View', 'Pin', 'Split Up', 'Split Down', 'Split Left', 'Split Right']);
  assert.equal(await menu.getByRole('separator').count(), 4);
  assert.equal((await state()).groups[0].active, docs[1].id, 'Right clicking an inactive tab does not switch documents');
  assert.equal(await item('Close').locator('kbd').textContent(), 'Ctrl+F4');
  await page.screenshot({ path: '.verification/editor-tabs/context-menu.png' });
  await choose('Copy Path');
  assert.equal(await page.evaluate(() => window.__copied), 'C:\\tab-fixture\\a.txt');
  await context('c.txt'); await choose('Copy Relative Path');
  assert.equal(await page.evaluate(() => window.__copied), 'nested\\c.txt');
  await context('a.txt'); await choose('Reveal in File Explorer');
  assert.deepEqual(await page.evaluate(() => window.__revealed), ['C:/tab-fixture/a.txt']);
  await context('c.txt'); await choose('Reveal in Explorer View');
  await page.waitForFunction(() => document.activeElement?.shadowRoot?.activeElement?.getAttribute('data-item-path') === 'nested/c.txt');
  await tab('b.txt').focus(); await page.keyboard.press('Shift+F10'); await menu.waitFor();
  await item('Reveal in Explorer View').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.shadowRoot?.activeElement?.getAttribute('data-item-path') === 'b.txt');
  console.log('PASS: exact menu contents, grouping, inactive targets, paths and both reveal actions');

  await context('d.txt');
  assert.equal(await item('Close to the Right').getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  await tab('b.txt').focus();
  await page.keyboard.press('Shift+F10'); await menu.waitFor();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
  assert.equal(await tab('b.txt').evaluate(e => e === document.activeElement), true, 'Escape returns keyboard focus to the target tab');
  await page.keyboard.press('Shift+F10'); await menu.waitFor();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await tab('b.txt').waitFor({ state: 'detached' });
  await reset();
  await context('a.txt'); await page.mouse.click(1100, 808); await menu.waitFor({ state: 'hidden' });
  await tab('d.txt').dispatchEvent('contextmenu', { clientX: 1275, clientY: 810, button: 2 });
  await menu.waitFor();
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1280 && bounds.y + bounds.height <= 820, 'Menu stays inside the viewport');
  await page.keyboard.press('Escape');
  console.log('PASS: disabled items, keyboard opening/selection, Escape, outside dismissal and edge avoidance');

  await context('a.txt'); await choose('Pin');
  assert.deepEqual((await state()).groups[0].sticky, [docs[0].id]);
  await context('a.txt'); assert.equal(await item('Unpin').count(), 1); await page.keyboard.press('Escape');
  await tab('a.txt').click(); await page.keyboard.press('Control+w');
  assert.equal(await tab('a.txt').count(), 1, 'Ctrl+W protects fixed tabs');
  await tab('a.txt').click({ button: 'middle' }); assert.equal(await tab('a.txt').count(), 1);
  await tab('a.txt').getByRole('button', { name: 'Unpin a.txt', exact: true }).click();
  assert.deepEqual((await state()).groups[0].sticky, []);
  await tab('a.txt').click(); await chord('Control+k', 'Shift+Enter');
  await page.waitForFunction(() => document.querySelector('.editor-tab.pinned'));
  await chord('Control+k', 'Shift+Enter');
  await page.waitForFunction(() => !document.querySelector('.editor-tab.pinned'));
  await documentAction('setSticky', docs[0].id, 'one', true);
  await context('a.txt'); await choose('Close');
  await tab('a.txt').waitFor({ state: 'detached' });
  console.log('PASS: Pin/Unpin, fixed-tab icon, keyboard and middle-click protection, explicit Close');

  await reset();
  const otherGroup = await documentAction('splitGroup');
  await context('c.txt', 0); await choose('Split Right');
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 3);
  let current = await state();
  assert.equal(current.groups[1].active, docs[2].id);
  assert.equal(current.groups[2].id, otherGroup);
  assert.equal(current.activeGroup, current.groups[1].id);
  assert.deepEqual(current.groups[0].tabs, docs.map(d => d.id));
  await context('a.txt', 0); await choose('Close Others');
  current = await state();
  assert.deepEqual(current.groups[0].tabs, [docs[0].id]);
  assert.equal(current.groups[1].active, docs[2].id);
  assert.equal(current.groups[2].active, docs[1].id);
  console.log('PASS: splitting an inactive tab inserts right of its own group; batch closing stays in the target group');

  await reset(); await context('b.txt'); await choose('Close to the Right');
  assert.deepEqual((await state()).groups[0].tabs, docs.slice(0, 2).map(d => d.id));
  await reset(); await documentAction('setSticky', docs[0].id, 'one', true);
  await documentAction('patchDoc', docs[2].id, { dirty: true });
  await tab('b.txt').click(); await chord('Control+k', 'u');
  await tab('b.txt').waitFor({ state: 'detached' });
  assert.deepEqual((await state()).groups[0].tabs, [docs[0].id, docs[2].id]);
  await tab('c.txt, unsaved').click(); await chord('Control+k', 'w');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.modal-panel').waitFor({ state: 'detached' });
  assert.equal(await tab('c.txt, unsaved').count(), 1);
  await chord('Control+k', 'w'); await page.getByRole('button', { name: "Don't Save", exact: true }).click();
  await tab('c.txt, unsaved').waitFor({ state: 'detached' });
  assert.deepEqual((await state()).groups[0].tabs, [docs[0].id]);
  console.log('PASS: Close Right, Close Saved and Close All, fixed/dirty protection and cancelled close');

  await reset(); await tab('b.txt').click();
  await page.keyboard.press('Shift+Alt+c');
  assert.equal(await page.evaluate(() => window.__copied), 'C:\\tab-fixture\\b.txt');
  await chord('Control+k', 'Control+Shift+c');
  assert.equal(await page.evaluate(() => window.__copied), 'b.txt');
  await page.keyboard.press('Shift+Alt+r');
  assert.deepEqual(await page.evaluate(() => window.__revealed), ['C:/tab-fixture/b.txt']);
  await page.keyboard.press('Control+F4'); await tab('b.txt').waitFor({ state: 'detached' });
  await page.keyboard.press('Control+Backslash');
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2);
  await moduleAction('store', 'setApp', { keybindings: [
    { key: 'Ctrl+F4', command: '-workbench.action.closeActiveEditor' },
    { key: 'Ctrl+Shift+Y', command: 'copyFilePath', when: 'editorFocus' },
  ] });
  await context('a.txt', 1);
  assert.equal(await item('Copy Path').locator('kbd').textContent(), 'Ctrl+Shift+Y');
  assert.equal(await item('Close').locator('kbd').textContent(), 'Ctrl+W');
  await page.keyboard.press('Escape');
  await tab('a.txt', 1).click(); await page.keyboard.press('Control+Shift+y');
  assert.equal(await page.evaluate(() => window.__copied), 'C:\\tab-fixture\\a.txt');
  await page.keyboard.press('Control+F4'); assert.equal(await tab('a.txt', 1).count(), 1);
  await page.keyboard.press('Control+w');
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 1);
  console.log('PASS: all default shortcuts, Ctrl+W alias, custom bindings, unbinding and accurate menu labels');

  await reset();
  await documentAction('openPath', 'C:/outside.txt', { pinned: true });
  await context('outside.txt');
  assert.equal(await item('Reveal in Explorer View').getAttribute('aria-disabled'), 'true');
  await choose('Copy Relative Path');
  assert.equal(await page.evaluate(() => window.__copied), 'C:\\outside.txt');
  await documentAction('newDocument'); await context('Untitled');
  for (const name of ['Copy Path', 'Copy Relative Path', 'Reveal in File Explorer', 'Reveal in Explorer View']) {assert.equal(await item(name).getAttribute('aria-disabled'), 'true');}
  await page.keyboard.press('Escape');
  await reset(); await documentAction('setSticky', docs[2].id, 'one', true);
  restored = await documentAction('session');
  await page.reload(); await tab('c.txt').waitFor();
  assert.deepEqual((await state()).groups[0].sticky, [docs[2].id]);
  assert.equal(await page.locator('.editor-tab').first().getAttribute('aria-label'), 'c.txt');
  console.log('PASS: untitled/outside resources, fixed-tab restoration and ordering');
  assert.deepEqual(errors, []);
  console.log('PASS: no browser page errors');
} catch (error) {
  await page.screenshot({ path: '.verification/editor-tabs/context-menu-failure.png' });
  console.error('Current state:', JSON.stringify(await state()));
  throw error;
} finally {
  await browser.close();
}
