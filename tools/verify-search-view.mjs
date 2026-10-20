import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Run against npm run dev; real search UI and Monaco, with isolated search IPC.
const root = 'C:/search-fixture';
const entries = [['api-core.md', 7], ['api-ssr.md', 2], ['api-web-components.md', 3], ['recipe-react.md', 1]];
const docs = entries.map(([name]) => ({ id: `file:///${root}/.agents/skills/trees/references/${name}`, path: `${root}/.agents/skills/trees/references/${name}`, name, language: 'markdown', text: 'export function example() {}\n'.repeat(10), encoding: 'utf8', eol: 'LF', revision: 'fixture', dirty: false, version: 1 }));
const matches = entries.flatMap(([, count], i) => Array.from({ length: count }, (_, n) => ({ path: docs[i].path, documentId: docs[i].id, version: 1, line: n + 1, column: 8, endLine: n + 1, endColumn: 16, preview: 'export function example() {}', matched: 'function' })));
const browser = await chromium.launch({ channel: 'msedge', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
const urls = {}, errors = [];
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
export async function bootstrap() { return {root:${JSON.stringify(root)},documents:${JSON.stringify(docs)},session:{sidebar:'search',sidebarWidth:430},recent:[],settings:{'files.autoSave':'off'},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command, args) {
 if (command === 'scan_workspace') return {paths:${JSON.stringify(entries.map(([name]) => name))},git:[],branch:null,warnings:[],truncated:false};
 if (command === 'inspect_file') return {kind:'text',size:100,stamp:'fixture'};
 if (command === 'read_document') return {text:'export function example() {}\\n'.repeat(10),encoding:'utf8',eol:'LF',revision:'fixture'};
 if (command === 'language_document' || command === 'search_ack') return;
 if (command === 'search_cancel') { window.__cancelled = args.requestId; return; }
 if (command === 'search_start') {
  window.__searches = (window.__searches ?? 0) + 1;
  window.__lastSearch = args;
  if (!window.__holdSearch) args.onBatch.onmessage({requestId:args.requestId,sequence:1,matches:${JSON.stringify(matches)},done:true,limited:false,errors:[]});
  return;
 }
 if (command === 'replacement_plan') {
  return Array.from(args.text.matchAll(/function/g), hit => {
   const before = args.text.slice(0, hit.index); const line = before.split('\\n').length;
   const column = before.length - before.lastIndexOf('\\n');
   return {line,column,endLine:line,endColumn:column+8,text:args.replacement};
  });
 }
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const action = (module, name, ...args) => page.evaluate(async ({ url, name, args }) => (await import(url))[name](...args), { url: urls[module], name, args });
const patch = data => action('store', 'setApp', data);
const state = () => page.evaluate(async url => { const s = (await import(url)).useApp.getState(); return { query: s.query, results: s.results, requestId: s.requestId, searching: s.searching, searchErrors: s.searchErrors, limited: s.limited }; }, urls.store);
const search = page.getByRole('region', { name: 'Search', exact: true });
const button = name => search.getByRole('button', { name, exact: true });
const results = search.getByRole('tree', { name: 'Search results' });
const settle = () => page.waitForFunction(() => document.querySelector('.search-summary')?.textContent.includes('13 results in 4 files'));
async function shot(name) { await page.mouse.move(1200, 950); await search.screenshot({ path: `.verification/search-view/${name}.png` }); }
async function assertToggle(label, field) {
  const previous = (await state()).query[field];
  await button(label).click();
  assert.equal((await state()).query[field], !previous);
  assert.equal(await button(label).getAttribute('aria-pressed'), String(!previous));
  await settle();
}
try {
  await mkdir('.verification/search-view', { recursive: true });
  await page.goto('http://localhost:1420');
  await search.waitFor();
  await search.getByRole('textbox', { name: 'Search text' }).fill('function');
  await settle();
  assert.deepEqual(await search.locator('.view-title button').evaluateAll(elements => elements.map(e => e.getAttribute('aria-label'))), ['Refresh Search', 'Clear Search Results', 'Open New Search Editor', 'View as Tree', 'Collapse All Results']);
  for (let i = 0; i < 2; i++) {
    await button('Collapse All Results').click();
    assert.equal(await results.locator('.result-row.match').count(), 0);
    assert.equal(await results.locator('.result-row.file[aria-expanded="false"]').count(), entries.length);
    assert.equal(await button('Expand All Results').locator('.codicon-expand-all').count(), 1);
    await button('Expand All Results').click();
    assert.equal(await results.locator('.result-row.match').count(), matches.length);
    assert.equal(await results.locator('.result-row.file[aria-expanded="true"]').count(), entries.length);
  }
  await results.locator('.result-row.file').first().click();
  await button('Collapse All Results').click();
  assert.equal(await results.locator('.result-row.match').count(), 0, 'Partially collapsed results collapse completely');
  await patch({ results: [matches[0]] });
  await button('Expand All Results').click();
  assert.equal(await results.locator('.result-row.match').count(), 1, 'Expansion uses current files even when old collapsed paths remain');
  await patch({ results: matches });
  assert.equal(await results.locator('.result-row.match').count(), matches.length);
  console.log('PASS: repeated collapse/expand, partial collapse and changed result files');
  const searchesBeforeViewToggle = await page.evaluate(() => window.__searches);
  assert.equal(await results.locator('.result-row.folder').count(), 0);
  assert.equal(await results.locator('.result-row.file[aria-level="1"]').count(), entries.length);
  assert.equal(await results.locator('.result-row.match[aria-level="2"]').count(), matches.length);
  assert.equal(await results.locator('.result-preview').first().textContent(), matches[0].preview, 'Flat matches do not repeat the file name');
  assert.equal(await results.locator('.result-path').first().textContent(), '.agents\\skills\\trees\\references');
  await shot('06-list-view');
  await results.locator('.result-row.file').first().click();
  await button('View as Tree').click();
  assert.equal(await page.getByRole('menu').count(), 0, 'The view button switches directly without a menu');
  assert.equal(await button('View as List').locator('.codicon-list-tree').count(), 1);
  assert.deepEqual(await results.locator('.result-row.folder .result-filename').allTextContents(), ['.agents', 'skills', 'trees', 'references']);
  assert.deepEqual(await results.locator('.result-row.folder').evaluateAll(elements => elements.map(e => [e.getAttribute('aria-level'), e.querySelector('.count').textContent])), [['1', '13'], ['2', '13'], ['3', '13'], ['4', '13']]);
  assert.equal(await results.locator('.result-row.file[aria-level="5"]').count(), entries.length);
  assert.equal(await results.locator('.result-row.match[aria-level="6"]').count(), matches.length - entries[0][1]);
  assert.equal(await results.locator('.result-path').count(), 0, 'Tree file headings do not repeat the directory path');
  await results.locator('.result-row.folder').nth(2).click();
  assert.equal(await results.locator('.result-row.folder').count(), 3);
  assert.equal(await results.locator('.result-row.file').count(), 0, 'Collapsing a folder hides its whole subtree');
  await results.locator('.result-row.folder').nth(2).click();
  await results.locator('.result-row.file').first().click();
  await shot('07-tree-view');
  await button('Collapse All Results').click();
  assert.equal(await results.locator('.result-row').count(), 1, 'Collapse all folds root directories');
  await button('Expand All Results').click();
  assert.equal(await results.locator('.result-row.match').count(), matches.length, 'Expand all opens directories and files');
  await results.locator('.result-row.file').first().click();
  await button('View as List').click();
  assert.equal(await button('View as Tree').locator('.codicon-list-flat').count(), 1);
  assert.equal(await results.locator('.result-row.folder').count(), 0);
  assert.equal(await results.locator('.result-row.file').count(), entries.length);
  assert.equal(await results.locator('.result-row.file[aria-expanded="false"]').count(), 1, 'Switching views preserves collapsed files');
  assert.equal(await search.locator('.selected').count(), 0, 'Switching views clears the previous selection');
  assert.equal(await page.evaluate(() => window.__searches), searchesBeforeViewToggle, 'Switching views does not rerun the search');
  await results.locator('.result-row.file').first().click();
  await button('View as Tree').focus();
  await page.keyboard.press('Enter');
  await button('View as List').waitFor();
  await page.keyboard.press('Space');
  await button('View as Tree').waitFor();
  await button('View as Tree').click();
  await results.locator('.result-row.folder').first().click({ button: 'right' });
  await search.getByRole('menu').getByRole('button', { name: 'Remove Result', exact: true }).click();
  assert.equal((await state()).results.length, 0, 'Removing a directory removes its descendant matches');
  await patch({ results: matches });
  await button('View as List').click();
  console.log('PASS: file-based list, nested directories, counts, collapse/expand, keyboard switching and directory removal');
  assert.equal(await search.locator('.selected').count(), 0);
  assert.equal(await search.locator('.result-line').count(), 0);
  assert.equal(await search.locator('.result-preview').first().evaluate(e => getComputedStyle(e).fontSize), '15px');
  assert.equal(await search.locator('.result-row').first().evaluate(e => e.getBoundingClientRect().height), 26);
  await shot('01-collapsed');
  await button('Toggle Replace').click();
  await shot('02-replace');
  await button('Toggle Search Details').click();
  assert.equal(await search.locator('input[type=checkbox],select').count(), 0);
  await shot('03-details');
  for (const [label, field] of [['Match Case (Alt+C)', 'caseSensitive'], ['Match Whole Word (Alt+W)', 'wholeWord'], ['Use Regular Expression (Alt+R)', 'regex'], ['Search only Changed Files', 'changedOnly'], ['Search only in Open Editors', 'openOnly'], ['Use Exclude Settings and Ignore Files', 'useIgnore']]) {await assertToggle(label, field);}
  await search.getByLabel('files to include', { exact: true }).fill('*.md');
  await search.getByLabel('files to exclude', { exact: true }).fill('**/vendor/**');
  await settle();
  assert.equal((await state()).query.include, '*.md');
  assert.equal((await state()).query.exclude, '**/vendor/**');
  console.log('PASS: layout, 15px typography, toolbar, inline options and filters');

  const sash = page.getByRole('separator', { name: 'Primary side bar width' });
  await sash.focus();
  for (let i = 0; i < 17; i++) {await sash.press('ArrowLeft');}
  await page.waitForFunction(() => document.querySelector('.search-view').getBoundingClientRect().width < 270);
  await shot('04-narrow');
  assert.equal(await search.locator('.count').evaluateAll(elements => elements.every(e => {
    const row = e.parentElement.getBoundingClientRect(), r = e.getBoundingClientRect();
    return r.x >= row.x && r.right <= row.right;
  })), true, 'Count badges remain visible in a narrow sidebar');
  for (let i = 0; i < 17; i++) {await sash.press('ArrowRight');}

  // Opening a preview must retain the original UTF-16 location after clipping.
  const distant = { ...matches[0], preview: 'x'.repeat(500) + 'function tail', column: 501, endColumn: 509 };
  await patch({ results: [distant] });
  assert.ok((await search.locator('.result-preview').textContent()).startsWith('…'));
  assert.equal(await search.locator('.result-preview mark').textContent(), 'function');
  await search.locator('.result-preview').click();
  // The fixture's real model has a short line; use an existing valid hit for navigation.
  await patch({ results: matches });
  await search.locator('.result-preview').first().click();
  assert.deepEqual(await page.evaluate(async url => { const s = (await import(url)).editor().getSelection(); return [s.startLineNumber, s.startColumn, s.endColumn]; }, urls.documents), [1, 8, 16]);
  await search.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await page.getByRole('tab', { name: /^Search\.code-search/ }).waitFor();
  console.log('PASS: clipped highlight, original source navigation and Open in editor');

  await button('Clear Search Results').click();
  const many = Array.from({ length: 20_000 }, (_, i) => ({ ...matches[0], path: `${root}/large.md`, line: i + 1, endLine: i + 1 }));
  await patch({ results: many });
  await results.evaluate(e => { e.scrollTop = e.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('.result-row.match:last-child')?.getAttribute('aria-label').includes(':20000:'));
  const bottom = await results.evaluate(e => ({
    scrollbar: e.offsetWidth - e.clientWidth,
    gap: e.getBoundingClientRect().top + e.clientHeight - e.querySelector('.result-row:last-child').getBoundingClientRect().bottom,
    remaining: e.scrollHeight - e.scrollTop - e.clientHeight,
  }));
  assert.equal(bottom.scrollbar, 12, 'Search results have a moderately wider scrollbar');
  assert.equal(bottom.gap, 48, 'The final match leaves visible space at the bottom');
  assert.equal(bottom.remaining, 0, 'The blank space is part of the actual scroll range');
  await shot('05-bottom-space');
  assert.ok(await search.locator('.result-row').count() < 70, 'Only a viewport of results is mounted');
  const tops = await search.locator('.result-row').evaluateAll(elements => elements.map(e => e.offsetTop));
  assert.ok(tops.slice(1).every((top, i) => top - tops[i] === 26));
  await results.focus(); await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('.result-row.selected')?.style.top === '0px');
  await button('Collapse All Results').click();
  assert.equal(await search.locator('.result-row').count(), 1);
  assert.equal(await results.evaluate(e => e.scrollTop), 0);
  await search.locator('.result-row.file').click();
  await results.evaluate(e => { e.scrollTop = e.scrollHeight; });
  await patch({ results: matches });
  assert.equal(await results.evaluate(e => e.scrollTop), 0, 'Shrinking results clamps the scroll offset');
  console.log('PASS: 20,000 results, 26px virtualization, keyboard selection and shrinking lists');

  await page.evaluate(() => { window.__holdSearch = true; });
  await button('Refresh Search').click();
  await button('Cancel Search').waitFor();
  const activeRequest = (await state()).requestId;
  await button('Cancel Search').click();
  assert.equal((await state()).searching, false);
  assert.equal(await page.evaluate(() => window.__cancelled), activeRequest);
  await button('Refresh Search').click();
  await button('Cancel Search').waitFor();
  const query = (await state()).query;
  await patch({ results: matches, limited: true, searchErrors: ['fixture warning'] });
  await button('Clear Search Results').click();
  assert.deepEqual(await state(), { query, results: [], requestId: null, searching: false, searchErrors: [], limited: false });
  await page.evaluate(() => { const args = window.__lastSearch; args.onBatch.onmessage({ requestId: args.requestId, matches: [{ path: 'stale' }], done: true, errors: [], limited: false }); });
  assert.equal((await state()).results.length, 0, 'Late batches cannot restore cleared results');
  const count = await page.evaluate(() => window.__searches);
  await search.getByRole('textbox', { name: 'Search text' }).fill('new query');
  await button('Clear Search Results').click();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__searches), count, 'Clear cancels the pending debounce');
  await page.evaluate(() => { window.__holdSearch = false; });
  await search.getByRole('textbox', { name: 'Search text' }).fill('function'); await settle();
  await search.getByRole('textbox', { name: 'Replace text' }).fill('method');
  await button('Replace All').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await button('Preserve Case').click();
  assert.equal(await button('Preserve Case').getAttribute('aria-pressed'), 'true');
  await search.locator('.result-row.match').first().hover();
  await search.locator('.result-row.match').first().getByRole('button', { name: 'Replace Match', exact: true }).click();
  assert.ok((await page.evaluate(async url => [...(await import(url)).models.values()].map(m => m.getValue()), urls.documents)).some(text => text.startsWith('export method')));
  assert.deepEqual(errors, []);
  console.log('PASS: clear cancels active/pending searches, ignores late batches and retains filters; replacement works');
} catch (error) {
  await page.screenshot({ path: '.verification/search-view/failure.png' }).catch(() => {});
  throw error;
} finally { await browser.close(); }
