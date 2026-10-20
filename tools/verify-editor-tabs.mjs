import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Run against npm run dev; IPC is isolated while the real tree, tabs and Monaco render.
// Keep native scrollbars enabled so headless defaults cannot hide a reserved gutter.
const browser = await chromium.launch({ channel: 'msedge', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const files = Array.from({ length: 12 }, (_, index) => `file-${String(index + 1).padStart(2, '0')}.txt`);
const longFile = `long-${'filename-'.repeat(35)}.txt`;
const paths = [...files, longFile, 'preview-a.txt', 'preview-b.txt', 'background.txt'];
const output = '.verification/editor-tabs';
const errors = [];
let restoreSession = false;
let documentsUrl;
page.on('request', request => {
  if (!documentsUrl && new URL(request.url()).pathname === '/src/documents.ts') {documentsUrl = request.url();}
});
page.on('pageerror', error => errors.push(String(error)));
await page.route('**/src/bridge.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() {
 const documents = ${JSON.stringify(restoreSession ? files.map(name => ({ id: `file:///C:/tab-fixture/${name}`, path: `C:/tab-fixture/${name}`, name, language: 'plaintext', text: `${name} content`, encoding: 'utf8', eol: 'LF', revision: 'fixture', dirty: false, version: 1 })) : [])};
 const session = documents.length ? {groups:[{id:'restored',tabs:documents.map(d=>d.id),active:documents.at(-1).id,preview:null,views:{}}],activeGroup:'restored'} : {};
 return {root:'C:/tab-fixture',documents,session,recent:[],settings:{},keybindings:[],warnings:[],dataDir:''};
}
export async function call(command, args) {
 if(command === 'inspect_file') return {kind:'text',size:20,stamp:'fixture'};
 if(command === 'scan_workspace') return {paths:${JSON.stringify(paths)},git:[],branch:null,warnings:[],truncated:false};
 if(command === 'read_document') return {text:args.path+' content',encoding:'utf8',eol:'LF',revision:'fixture'};
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const row = name => page.locator('file-tree-container').locator(`[data-item-path="${name}"]`).first();
const bar = (group = 0) => page.locator('.editor-tabs').nth(group);
async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function geometry(group = 0) {
  return bar(group).evaluate(element => {
    const viewport = element.getBoundingClientRect();
    const active = element.querySelector('[aria-selected="true"]');
    const bounds = active?.getBoundingClientRect();
    return { scrollLeft: element.scrollLeft, width: element.clientWidth, scrollWidth: element.scrollWidth,
      name: active?.getAttribute('aria-label'), left: bounds ? bounds.left - viewport.left : null,
      right: bounds ? bounds.right - viewport.left : null, tabWidth: bounds?.width };
  });
}
async function visible(label, group = 0) {
  await settle();
  const bounds = await geometry(group);
  assert.ok(bounds.left !== null && bounds.left >= -1 && (bounds.tabWidth > bounds.width ? Math.abs(bounds.left) <= 1 : bounds.right <= bounds.width + 1), `${label}: ${JSON.stringify(bounds)}`);
}
async function treeFocus(name) {
  assert.equal(await page.evaluate(() => {
    const tree = document.querySelector('file-tree-container');
    return document.activeElement === tree ? tree.shadowRoot.activeElement?.getAttribute('data-item-path') : null;
  }), name);
}
async function open(name, pinned = false) {
  await row(name)[pinned ? 'dblclick' : 'click']();
  await page.waitForFunction(name => document.querySelector('.editor-tab.active')?.getAttribute('aria-label') === name, name);
  await settle();
}
async function documentAction(action, ...args) {
  const result = await page.evaluate(async ({ action, args, documentsUrl }) => {
    // Reuse Vite's loaded URL, including its HMR timestamp, to keep module singletons.
    const documents = await import(documentsUrl);
    return documents[action](...args);
  }, { action, args, documentsUrl });
  await settle();
  return result;
}
try {
  await mkdir(output, { recursive: true });
  await page.goto('http://localhost:1420');
  await row(files[0]).waitFor();
  await open(files[0], true);
  const overlay = page.locator('.editor-tabs-scrollbar').first();
  const slider = overlay.locator('.editor-tabs-scrollbar-thumb');
  assert.equal(await overlay.isVisible(), false, 'No scrollbar is shown when tabs fit');
  for (const name of files.slice(1)) {await open(name, true);}
  await page.screenshot({ path: `${output}/overflow.png` });
  assert.ok((await geometry()).scrollWidth > (await geometry()).width);
  assert.equal(await bar().evaluate(element => element.offsetHeight - element.clientHeight), 0, 'The tab scrollbar does not reserve layout height');
  await visible('New last tab is revealed');
  const layout = await bar().evaluate(element => {
    const tabs = element.getBoundingClientRect();
    const active = element.querySelector('[aria-selected="true"]').getBoundingClientRect();
    const breadcrumbs = element.parentElement.nextElementSibling.getBoundingClientRect();
    return { tabGap: tabs.bottom - active.bottom, breadcrumbGap: breadcrumbs.top - tabs.bottom };
  });
  assert.equal(layout.tabGap, 0, 'The active tab fills the viewport height');
  assert.ok(layout.breadcrumbGap <= 1, 'Only the one-pixel toolbar border separates tabs and breadcrumbs');
  await bar().hover();
  await settle();
  assert.equal(await slider.evaluate(element => getComputedStyle(element).opacity), '1');
  const railBounds = await overlay.boundingBox();
  const sliderBounds = await slider.boundingBox();
  await page.mouse.move(sliderBounds.x + sliderBounds.width / 2, sliderBounds.y + sliderBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(railBounds.x + sliderBounds.width / 2, railBounds.y + 20, { steps: 6 });
  await page.mouse.up();
  await settle();
  assert.ok((await geometry()).scrollLeft <= 1, 'Dragging the overlay thumb scrolls left even outside the rail');
  assert.equal(await overlay.getAttribute('data-dragging'), null, 'Pointer capture is released after dragging');
  await open(files.at(-1));
  await overlay.click({ position: { x: 8, y: 1 } });
  await settle();
  assert.ok((await geometry()).scrollLeft <= 1, 'Clicking the overlay rail scrolls to that position');
  await open(files.at(-1));
  await bar().hover();
  const toolbar = await page.locator('.tabs-toolbar').first().boundingBox();
  await page.screenshot({ path: `${output}/tabs-overlay.png`, clip: { ...toolbar, height: toolbar.height + 22 } });
  console.log('PASS: the scrollbar overlays the tabs without a gutter; thumb dragging and rail clicking work');
  await open(files[0]);
  await visible('Existing first tab is revealed');
  await treeFocus(files[0]);
  await open(files.at(-1));
  await visible('Existing last tab is revealed');
  await treeFocus(files.at(-1));
  await bar().evaluate(element => { element.scrollLeft = 0; });
  await settle();
  assert.equal((await geometry()).scrollLeft, 0, 'Manual scrolling stays put');
  await open(files.at(-1));
  await visible('Opening the same active file reveals it again');
  console.log('PASS: new, existing and repeated opens reveal the tab without stealing tree focus');

  const visiblePosition = (await geometry()).scrollLeft;
  await open(files.at(-1));
  assert.equal((await geometry()).scrollLeft, visiblePosition, 'A fully visible tab does not move');
  await page.locator('.monaco-host .monaco-editor').click();
  await bar().evaluate(element => { element.scrollLeft = 0; });
  await page.keyboard.type('x');
  await settle();
  assert.equal((await geometry()).scrollLeft, 0, 'Typing does not pull the manually scrolled tab back');
  await page.keyboard.press('Control+z');
  await documentAction('openPath', 'C:/tab-fixture/background.txt', { background: true, pinned: true });
  assert.equal((await geometry()).name, files.at(-1));
  assert.equal((await geometry()).scrollLeft, 0, 'Background opening does not reveal the active or new tab');
  await open(files.at(-1));
  await bar().hover();
  await page.mouse.wheel(0, -400);
  await settle();
  assert.ok((await geometry()).scrollLeft < visiblePosition, 'Wheel scrolling still works');
  const wheelPosition = (await geometry()).scrollLeft;
  await settle();
  assert.equal((await geometry()).scrollLeft, wheelPosition, 'Wheel scrolling is not immediately undone');
  console.log('PASS: visible tabs stay put; manual scrolling, typing and background opening do not force a reveal');

  await open(longFile, true);
  assert.ok((await geometry()).tabWidth > (await geometry()).width);
  await visible('An oversized tab aligns its left edge');
  await page.keyboard.press('Control+w');
  await page.waitForFunction(name => document.querySelector('.editor-tab.active')?.getAttribute('aria-label') !== name, longFile);
  await visible('Closing a tab reveals its replacement');
  await open('preview-a.txt');
  const previewCount = await page.locator('.editor-tab').count();
  await visible('A new preview at the end is revealed');
  await open('preview-b.txt');
  assert.equal(await page.locator('.editor-tab').count(), previewCount, 'A preview replaces the previous preview');
  assert.equal(await page.getByRole('tab', { name: 'preview-a.txt', exact: true }).count(), 0);
  await visible('The replacement preview is revealed');
  await treeFocus('preview-b.txt');
  await open('preview-b.txt', true);
  await bar().evaluate(element => { element.scrollLeft = 0; });
  await page.keyboard.press('Control+w');
  await page.waitForFunction(() => !document.querySelector('.editor-tab.active.preview'));
  await visible('Closing the active tab reveals the previous tab even after manual scrolling');
  await open(files.at(-1));
  await page.setViewportSize({ width: 900, height: 820 });
  await visible('Shrinking the viewport keeps the active tab visible');
  await page.setViewportSize({ width: 1280, height: 820 });
  await visible('Growing the viewport keeps the active tab visible');
  console.log('PASS: long filenames, preview replacement, closing and resizing reveal the correct tab');

  await page.mouse.move(2, 2);
  const colors = await page.locator('.tabs-toolbar').first().evaluate(toolbar => {
    const active = getComputedStyle(toolbar.querySelector('.editor-tab.active'));
    const inactive = getComputedStyle(toolbar.querySelector('.editor-tab:not(.active)'));
    return { toolbar: getComputedStyle(toolbar).backgroundColor, activeBackground: active.backgroundColor,
      activeForeground: active.color, activeTopBorder: active.borderTopColor,
      inactiveBackground: inactive.backgroundColor, inactiveForeground: inactive.color };
  });
  assert.deepEqual(colors, { toolbar: 'rgb(43, 43, 43)', activeBackground: 'rgb(31, 31, 31)',
    activeForeground: 'rgb(204, 204, 204)', activeTopBorder: 'rgb(0, 120, 212)',
    inactiveBackground: 'rgb(43, 43, 43)', inactiveForeground: 'rgb(157, 157, 157)' });
  const inactive = page.locator('.editor-tab:not(.active)').filter({ hasText: files.at(-2) });
  await inactive.hover();
  assert.deepEqual(await inactive.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, foreground: getComputedStyle(element).color })),
    { background: 'rgb(53, 53, 53)', foreground: 'rgb(204, 204, 204)' });
  await page.locator('.tabs-toolbar').first().screenshot({ path: `${output}/tabs-colors.png` });
  await page.screenshot({ path: `${output}/after.png` });
  await page.locator('.editor-tab.active').hover();
  assert.equal(await page.locator('.editor-tab.active').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(31, 31, 31)');
  console.log('PASS: normal, active and hover colors match the reference; active tabs have a blue top border');

  await open(files.at(-1));
  await page.keyboard.press('Control+Tab');
  await page.waitForFunction(() => document.querySelector('.editor-tab.active')?.getAttribute('aria-label') === 'background.txt');
  await visible('Ctrl+Tab reveals the next tab');
  await page.getByRole('tab', { name: 'background.txt', exact: true }).press('ArrowLeft');
  await page.waitForFunction(name => document.querySelector('.editor-tab.active')?.getAttribute('aria-label') === name, files.at(-1));
  await visible('The tab arrow keys reveal the selected tab');
  console.log('PASS: keyboard tab switching reveals the active tab');

  const secondGroup = await documentAction('splitGroup');
  await visible('The source group is revealed after splitting');
  await visible('The new group reveals its active tab', 1);
  for (const name of files) {await documentAction('openPath', `C:/tab-fixture/${name}`, { group: secondGroup, pinned: true });}
  await visible('New tabs in a split group are revealed', 1);
  await bar().evaluate(element => { element.scrollLeft = 0; });
  await documentAction('openPath', `C:/tab-fixture/${files[0]}`, { group: secondGroup });
  await visible('The second group can reveal its first tab', 1);
  assert.equal((await geometry()).scrollLeft, 0, 'A request for the second group does not scroll the first');
  const session = await documentAction('session');
  const ids = { firstGroup: session.groups[0].id, active: session.groups[1].active,
    moved: session.groups[0].tabs.find(id => id.endsWith('/file-03.txt')) };
  await documentAction('moveTab', ids.active, secondGroup, secondGroup);
  await visible('Reordering the same active tab to the end reveals it', 1);
  await documentAction('moveTab', ids.moved, ids.firstGroup, secondGroup);
  await visible('Moving a tab between groups reveals it in the target', 1);
  await visible('Removing a preceding tab keeps the source active tab visible');
  console.log('PASS: split groups scroll independently and tab moves reveal their target');

  restoreSession = true;
  await page.reload();
  await row(files[0]).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.editor-tab').length === 12);
  await visible('Restoring a session reveals the last active tab');
  assert.equal((await geometry()).name, files.at(-1));
  await page.screenshot({ path: `${output}/restored.png` });
  console.log('PASS: session restoration reveals the active tab');
  assert.deepEqual(errors, []);
  console.log('PASS: no browser page errors');
} finally {
  await browser.close();
}
