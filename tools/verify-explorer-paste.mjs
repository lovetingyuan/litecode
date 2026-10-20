import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, copyFile, writeFile, readFile, access, unlink } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real Windows clipboard, Tauri IPC, filesystem and WebView2 input. Requires
// `cargo build --manifest-path src-tauri/Cargo.toml` and `npm run dev`.
// The portable app and every disk operation are confined to this fixture.
assert.equal(process.platform, 'win32', 'This verification requires Windows');
const run = path.resolve('.verification', `explorer-paste-${Date.now()}`);
const root = path.join(run, 'project'), external = path.join(run, 'external'), appDirectory = path.join(run, 'app');
const port = Number(process.env.LITECODE_PASTE_DEBUG_PORT ?? 9228);
const endpoint = `http://127.0.0.1:${port}`;
assert.equal(await fetch(`${endpoint}/json/version`).then(() => true, () => false), false, 'The test debugging port is already in use');
for (const directory of [appDirectory, path.join(appDirectory, 'data'), external, path.join(external, '中文 文件夹/empty'), path.join(root, 'target'), path.join(root, 'alternate'), path.join(root, 'empty')]) await mkdir(directory, { recursive: true });
await writeFile(path.join(external, 'a.txt'), 'native a');
await writeFile(path.join(external, 'b.txt'), 'native b');
await writeFile(path.join(external, 'gone.txt'), 'source disappears during confirmation');
await writeFile(path.join(external, '中文 文件夹/deep.txt'), 'unicode directory');
await writeFile(path.join(root, 'internal.txt'), 'internal source');
await writeFile(path.join(root, 'target/anchor.txt'), 'anchor');
await writeFile(path.join(appDirectory, 'data/session-main.json'), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(appDirectory, 'data/settings.json'), JSON.stringify({ 'files.autoSave': 'off' }));
await copyFile('src-tauri/target/debug/litecode.exe', path.join(appDirectory, 'LiteCode.exe'));

// Keep the original clipboard formats in an STA process and restore them even
// on failure. Only protocol acknowledgements, never clipboard contents, go out.
const clipboardScript = path.join(run, 'clipboard.ps1');
await writeFile(clipboardScript, `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$backup = New-Object System.Windows.Forms.DataObject
$original = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $original) {
  foreach ($format in $original.GetFormats($false)) {
    $value = $original.GetData($format, $false)
    if ($null -ne $value) { $backup.SetData($format, $false, $value) }
  }
}
try {
  [Console]::WriteLine('ready')
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      if ($request.kind -eq 'restore') { break }
      if ($request.kind -eq 'files') {
        $files = New-Object System.Collections.Specialized.StringCollection
        foreach ($file in $request.paths) { [void]$files.Add([string]$file) }
        [System.Windows.Forms.Clipboard]::SetFileDropList($files)
      } elseif ($request.kind -eq 'text') {
        [System.Windows.Forms.Clipboard]::SetText([string]$request.text)
      }
      [Console]::WriteLine('ok')
    } catch { [Console]::WriteLine('error: ' + $_.Exception.Message) }
  }
} finally {
  if ($backup.GetFormats($false).Length) { [System.Windows.Forms.Clipboard]::SetDataObject($backup, $true) }
  else { [System.Windows.Forms.Clipboard]::Clear() }
  [Console]::WriteLine('restored')
}
`);
const clipboard = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', clipboardScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: clipboard.stdout })[Symbol.asyncIterator]();
let clipboardErrors = '';
clipboard.stderr.on('data', chunk => { clipboardErrors += chunk; });
async function nextClipboardLine(expected) {
  const result = await lines.next();
  assert.equal(result.value, expected, `Clipboard helper: ${result.value ?? clipboardErrors}`);
}
await nextClipboardLine('ready');
async function setClipboard(request) { clipboard.stdin.write(JSON.stringify(request) + '\n'); await nextClipboardLine('ok'); }
const setFiles = (...files) => setClipboard({ kind: 'files', paths: files.map(file => path.join(external, file)) });
let app, browser, page;
const errors = [];
async function missing(file) { await assert.rejects(access(file)); }
async function invoke(command, args) { return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }); }
async function checkDisk(file, contents) { assert.equal(await readFile(file, 'utf8'), contents); }
const checks = [];
try {
  app = spawn(path.join(appDirectory, 'LiteCode.exe'), [], {
    windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', chunk => { if (String(chunk).includes('panicked')) errors.push(String(chunk)); });
  const started = Date.now();
  while (!await fetch(`${endpoint}/json/version`).then(response => response.ok, () => false)) {
    if (app.exitCode !== null) throw new Error(`Fixture app exited with ${app.exitCode}`);
    if (Date.now() - started > 60000) throw new Error('WebView2 debugging did not start');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? await context.waitForEvent('page');
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  const tree = page.locator('file-tree-container');
  const row = item => tree.locator(`[data-item-path="${item}"]`).first();
  const dialog = page.getByRole('dialog');
  const selected = () => tree.locator('[aria-selected="true"]').evaluateAll(rows => rows.map(row => row.dataset.itemPath).sort());
  async function pasteKey() { await page.keyboard.press('Control+v'); await dialog.waitFor(); }
  async function confirm() { await dialog.getByRole('button', { name: 'Copy', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); }
  async function switchWorkspace(directory) {
    await invoke('open_workspace', { path: directory, newWindow: false });
    await page.evaluate(async root => {
      const { setApp } = await import('/src/store.ts');
      setApp({ root });
      await (await import('/src/Explorer.tsx')).refreshTree();
    }, directory);
  }
  await row('internal.txt').waitFor({ timeout: 120000 });
  console.log('Native fixture ready');
  assert.equal((await page.evaluate(async () => (await import('/src/store.ts')).useApp.getState().root)).replaceAll('\\', '/').replace('//?/', '').toLowerCase(), root.replaceAll('\\', '/').toLowerCase());

  await setFiles('a.txt');
  await row('target/').click();
  await pasteKey();
  assert.match(await dialog.innerText(), /Copy 'a.txt'/);
  assert.match(await dialog.getByLabel('Items to copy').innerText(), /a.txt/);
  await missing(path.join(root, 'target/a.txt'));
  await page.screenshot({ path: path.join(run, 'copy-confirmation.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await missing(path.join(root, 'target/a.txt'));
  checks.push('Ctrl+V shows copy confirmation; Escape makes no disk changes');

  await row('target/').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await dialog.waitFor();
  await confirm();
  await row('target/a.txt').waitFor();
  await checkDisk(path.join(root, 'target/a.txt'), 'native a');
  assert.deepEqual(await selected(), ['target/a.txt']);
  await row('target/a.txt').click();
  await pasteKey();
  await confirm();
  await row('target/a copy.txt').waitFor();
  await checkDisk(path.join(root, 'target/a copy.txt'), 'native a');
  await checkDisk(path.join(external, 'a.txt'), 'native a');
  checks.push('Right-click paste copies native files; file targets use their parent; repeated paste increments names');

  await setFiles('a.txt', 'b.txt', '中文 文件夹');
  await page.locator('.section-heading').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /3 files and folders/);
  await confirm();
  await row('中文 文件夹/').waitFor();
  await checkDisk(path.join(root, '中文 文件夹/deep.txt'), 'unicode directory');
  await access(path.join(root, '中文 文件夹/empty'));
  assert.deepEqual(await selected(), ['a.txt', 'b.txt', '中文 文件夹/'].sort());
  checks.push('Root context menu copies multi-selection, Unicode directories, and empty subdirectories and selects new rows');

  await setFiles('b.txt');
  await page.locator('.section-heading').getByRole('button', { name: 'PROJECT', exact: true }).press('Control+v');
  await dialog.waitFor();
  await confirm();
  await row('b copy.txt').waitFor();
  await row('target/').click();
  const treeBounds = await tree.boundingBox();
  await page.mouse.click(treeBounds.x + 50, treeBounds.y + treeBounds.height - 15);
  await pasteKey();
  await confirm();
  await row('b copy 2.txt').waitFor();
  await missing(path.join(root, 'target/b.txt'));
  checks.push('Keyboard paste on the workspace heading and blank tree space targets root despite an old focused folder');

  await setClipboard({ kind: 'text', text: 'renamed-file' });
  await row('internal.txt').click();
  await page.keyboard.press('F2');
  const rename = tree.locator('input');
  await rename.waitFor();
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(150);
  assert.equal(await dialog.count(), 0);
  assert.match(await rename.inputValue(), /renamed-file/);
  await page.keyboard.press('Escape');
  await row('internal.txt').click();
  await page.keyboard.press('Control+c');
  await row('alternate/').click();
  await pasteKey();
  await confirm();
  await row('alternate/internal.txt').waitFor();
  await checkDisk(path.join(root, 'alternate/internal.txt'), 'internal source');
  await checkDisk(path.join(root, 'internal.txt'), 'internal source');
  checks.push('Rename inputs retain native text paste; internal file copy also requires confirmation');

  await setClipboard({ kind: 'text', text: 'clipboard changed' });
  await row('target/').click();
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(250);
  assert.equal(await dialog.count(), 0);
  await missing(path.join(root, 'target/internal.txt'));
  await row('internal.txt').click();
  await page.keyboard.press('Control+x');
  await row('target/').click();
  await page.keyboard.press('Control+v');
  await row('target/internal.txt').waitFor();
  await missing(path.join(root, 'internal.txt'));
  await checkDisk(path.join(root, 'target/internal.txt'), 'internal source');
  checks.push('Text clipboard invalidates internal copy; existing internal cut/paste still moves files');

  await setFiles('b.txt');
  await row('alternate/').click();
  await pasteKey();
  await setFiles('a.txt');
  await confirm();
  await page.getByText('The clipboard changed; paste the files again', { exact: false }).waitFor();
  await missing(path.join(root, 'alternate/b.txt'));
  await missing(path.join(root, 'alternate/a.txt'));
  checks.push('Changing the native clipboard during confirmation rejects the stale request');

  await setFiles('b.txt', 'gone.txt');
  await row('alternate/').click();
  await pasteKey();
  await unlink(path.join(external, 'gone.txt'));
  await confirm();
  await row('alternate/b.txt').waitFor();
  await checkDisk(path.join(root, 'alternate/b.txt'), 'native b');
  await missing(path.join(root, 'alternate/gone.txt'));
  await page.getByText('Pasted 1 item(s).', { exact: false }).waitFor();
  assert.deepEqual(await selected(), ['alternate/b.txt']);
  checks.push('A vanished source reports partial failure and selects only successfully copied files');

  await setFiles('a.txt');
  await row('alternate/').click();
  await pasteKey();
  const emptyRoot = path.join(root, 'empty');
  await switchWorkspace(emptyRoot);
  await dialog.waitFor({ state: 'hidden' });
  await missing(path.join(root, 'alternate/a.txt'));
  await page.locator('.section-heading').getByRole('button', { name: 'EMPTY', exact: true }).waitFor();
  await tree.waitFor();
  const bounds = await tree.boundingBox();
  await page.mouse.click(bounds.x + 50, bounds.y + 50, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await dialog.waitFor();
  await confirm();
  await row('a.txt').waitFor();
  await checkDisk(path.join(emptyRoot, 'a.txt'), 'native a');
  checks.push('Workspace changes cancel pending confirmation; empty-tree context menu targets its workspace root');

  const snapshot = await invoke('read_file_clipboard');
  await assert.rejects(invoke('paste_file_clipboard', { expectedSequence: snapshot.sequence, expectedRoot: emptyRoot, targetDirectory: external }));
  await assert.rejects(invoke('paste_file_clipboard', { expectedSequence: snapshot.sequence, expectedRoot: root, targetDirectory: emptyRoot }));
  await assert.rejects(invoke('file_operation', { operation: { kind: 'copy', path: path.join(external, 'a.txt'), destination: path.join(emptyRoot, 'forbidden.txt') } }));
  checks.push('Native copy rejects outside destinations and stale workspaces without granting arbitrary source access');
  await page.screenshot({ path: path.join(run, 'pasted.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(run, 'results.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(checks.map(check => `PASS: ${check}`).join('\n'));
  console.log(`Evidence: ${run}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => 'Page unavailable'));
    console.error({ errors, resources: await page.evaluate(() => performance.getEntriesByType('resource').slice(-10).map(entry => entry.name)).catch(() => []) });
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  app?.kill();
  clipboard.stdin.write(JSON.stringify({ kind: 'restore' }) + '\n');
  clipboard.stdin.end();
  await nextClipboardLine('restored');
}
