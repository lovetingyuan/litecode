import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, copyFile, cp, writeFile, unlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

// Run after cargo build, with npm run dev serving the frontend. Uses a portable
// native app and real Git/watchers; no IPC mocks or user settings are involved.
const run = path.resolve('.verification', `git-ignore-${Date.now()}`);
const app = path.join(run, 'app'), data = path.join(app, 'data'), root = path.join(run, 'fixture');
await mkdir(data, { recursive: true });
await mkdir(path.join(root, 'build', 'deep'), { recursive: true });
await mkdir(path.join(root, 'src', 'cache'), { recursive: true });
await mkdir(path.join(root, 'server', 'api'), { recursive: true });
const rules = 'build/\n*.log\n!keep.log\ntracked.txt\n';
for (const [file, text] of Object.entries({
  '.gitignore': rules, 'build/deep/generated.txt': 'ignored directory child',
  'ignored.log': 'ignored file', 'keep.log': 'negated rule', 'README.txt': 'ordinary file',
  'tracked.txt': 'tracked despite matching ignore rule',
  'src/.gitignore': 'cache/\n', 'src/cache/cached.txt': 'nested ignored child',
  'server/api/hello.txt': 'visible before server is ignored',
})) await writeFile(path.join(root, file), text);
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
git('init', '--quiet'); git('add', '-f', 'tracked.txt');
await copyFile('src-tauri/target/debug/litecode.exe', path.join(app, 'LiteCode.exe'));
await cp('src-tauri/tools', path.join(app, 'tools'), { recursive: true });
await writeFile(path.join(data, 'session-main.json'), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ 'files.autoSave': 'off' }));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const child = spawn(path.join(app, 'LiteCode.exe'), [], { cwd: app, windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server` }, stdio: ['ignore', 'pipe', 'pipe'] });
let nativeLog = '';
child.stdout.on('data', data => { nativeLog += data; });
child.stderr.on('data', data => { nativeLog += data; });
let launchError;
child.on('error', error => { launchError = error; });
let browser, page;
const errors = [], checks = [];
try {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Native app exited: ${child.exitCode}`);
    if (await fetch(`${endpoint}/json/version`).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  await context.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.evaluate(() => performance.setResourceTimingBufferSize(10_000));
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.waitForURL('http://localhost:1420/**', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const tree = page.locator('file-tree-container');
  const row = relative => tree.locator(`[data-item-path="${relative}"]`).first();
  const tabs = name => page.getByRole('tab', { name, exact: true });
  const color = locator => locator.evaluate(el => getComputedStyle(el).color);
  const ignoredColor = 'rgb(140, 140, 140)';
  await row('build/').waitFor();
  const urls = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('resource').flatMap(e => {
    const match = new URL(e.name).pathname.match(/^\/src\/(documents|store|workspaceTree)\.ts$/);
    return match ? [[match[1], e.name]] : [];
  })));
  async function action(module, method, ...args) {
    return page.evaluate(async ({ url, method, args }) => (await import(url))[method](...args), { url: urls[module], method, args });
  }
  async function open(relative, pinned = true) {
    return action('documents', 'openPath', path.join(root, relative), { pinned });
  }
  async function ignoredInBoth(relative, expected) {
    const name = path.basename(relative);
    await page.waitForFunction(({ relative, name, expected }) => {
      const row = document.querySelector('file-tree-container')?.shadowRoot?.querySelector(`[data-item-path="${relative}"]`);
      const labels = [...document.querySelectorAll('.editor-tab-label')].filter(el => el.textContent === name);
      return row && (row.dataset.itemGitStatus === 'ignored') === expected && labels.length > 0
        && labels.every(el => el.classList.contains('ignored') === expected);
    }, { relative, name, expected });
    const label = row(relative).locator('[data-item-section="content"]');
    for (const tabLabel of await tabs(name).locator('.editor-tab-label').all()) {
      assert.equal((await color(tabLabel)) === ignoredColor, expected, `${name}: tab color`);
    }
    assert.equal((await color(label)) === ignoredColor, expected, `${relative}: tree color`);
  }
  await row('build/').click();
  await row('build/deep/').click();
  await row('build/deep/generated.txt').waitFor();
  const id = await open('build/deep/generated.txt', false);
  await ignoredInBoth('build/deep/generated.txt', true);
  assert.ok(await tabs('generated.txt').evaluate(el => el.classList.contains('preview')));
  await tabs('generated.txt').hover(); await ignoredInBoth('build/deep/generated.txt', true);
  await action('documents', 'keepOpen', id);
  const group = await page.evaluate(async url => (await import(url)).useApp.getState().activeGroup, urls.store);
  await action('documents', 'setSticky', id, group, true);
  assert.ok(await tabs('generated.txt').evaluate(el => el.classList.contains('pinned')));
  await ignoredInBoth('build/deep/generated.txt', true);
  await page.screenshot({ path: path.join(run, 'ignored-preview-and-pinned.png') });
  checks.push('Ignored directory descendants, preview, active, hovered and pinned tab names use #8C8C8C');
  await open('ignored.log'); await ignoredInBoth('ignored.log', true);
  await open('keep.log'); await ignoredInBoth('keep.log', false);
  await open('tracked.txt'); await ignoredInBoth('tracked.txt', false);
  await open('README.txt'); await ignoredInBoth('README.txt', false);
  checks.push('Single-file ignores, negation and tracked-file precedence match native Git statuses');
  await open('src/cache/cached.txt'); await ignoredInBoth('src/cache/cached.txt', true);
  await action('documents', 'splitGroup', group);
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2);
  assert.equal(await tabs('cached.txt').count(), 2);
  await ignoredInBoth('src/cache/cached.txt', true);
  await page.screenshot({ path: path.join(run, 'ignored-split-tabs.png') });
  checks.push('Nested .gitignore decorates both split editor groups');
  await open('server/api/hello.txt'); await ignoredInBoth('server/api/hello.txt', false);
  // The directories are already expanded and their negative inheritance results
  // have been cached before the new rule is added.
  await writeFile(path.join(root, '.gitignore'), rules + 'server/\n');
  await ignoredInBoth('server/api/hello.txt', true);
  assert.equal(await row('server/').getAttribute('data-item-git-status'), 'ignored');
  assert.equal(await row('server/api/').getAttribute('data-item-git-status'), 'ignored');
  await writeFile(path.join(root, '.gitignore'), rules);
  await ignoredInBoth('server/api/hello.txt', false);
  await writeFile(path.join(root, '.gitignore'), rules + 'server/\n');
  await ignoredInBoth('server/api/hello.txt', true);
  await page.screenshot({ path: path.join(run, 'server-rule-added-after-expansion.png') });
  checks.push('Adding, removing and readding server/ updates already-expanded descendants and open tabs');
  await writeFile(path.join(root, '.gitignore'), '!tracked.txt\n');
  await unlink(path.join(root, 'src/.gitignore'));
  // Do not manually refresh: this verifies the native filesystem watcher.
  await ignoredInBoth('src/cache/cached.txt', false);
  await open('build/deep/generated.txt'); await ignoredInBoth('build/deep/generated.txt', false);
  await ignoredInBoth('ignored.log', false);
  await writeFile(path.join(root, '.gitignore'), rules);
  await writeFile(path.join(root, 'src/.gitignore'), 'cache/\n');
  await ignoredInBoth('build/deep/generated.txt', true);
  await open('src/cache/cached.txt'); await ignoredInBoth('src/cache/cached.txt', true);
  checks.push('Saving, deleting and recreating ignore rules updates tree and already-open tabs through native watchers');
  const snapshot = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('scan_workspace'));
  assert.ok(snapshot.git.some(g => g.path === 'build/' && g.status === 'ignored'));
  assert.ok(!snapshot.git.some(g => g.path === 'build/deep/generated.txt'));
  // Reject stale snapshots in both views before a new workspace scan arrives.
  await action('store', 'setApp', { root: path.join(run, 'other') });
  await page.waitForFunction(() => !document.querySelector('.editor-tab-label.ignored'));
  assert.deepEqual(errors, []);
  checks.push('Workspace changes clear old ignore decorations');
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ passed: true, checks, errors, git: snapshot.git }, null, 2));
  console.log(JSON.stringify({ passed: true, run, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png'), timeout: 10_000 }).catch(() => {});
  console.error(`Evidence: ${run}`);
  console.error(nativeLog);
  console.error(await page?.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 2000) })).catch(() => null));
  throw error;
} finally {
  // Only the isolated process created above is terminated.
  if (page) await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' })).catch(() => {});
  await browser?.close().catch(() => {});
  if (child.exitCode === null && child.pid) child.kill();
}
