import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, copyFile, cp, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

// Uses the actual Tauri IPC and media protocol in an isolated portable app.
const appIndex = process.argv.indexOf('--app');
const executable = path.resolve(appIndex < 0 ? 'src-tauri/target/debug/litecode.exe' : process.argv[appIndex + 1]);
const run = path.resolve('.verification', `media-${Date.now()}`);
const app = path.join(run, 'app'), data = path.join(app, 'data'), root = path.join(run, 'fixture');
await mkdir(data, { recursive: true }); await mkdir(root, { recursive: true });
await copyFile(executable, path.join(app, 'LiteCode.exe'));
await cp('src-tauri/tools', path.join(app, 'tools'), { recursive: true });
await writeFile(path.join(data, 'session-main.json'), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ 'files.autoSave': 'off' }));
await writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#0078d4"/><circle cx="128" cy="128" r="80" fill="white"/></svg>');
await writeFile(path.join(root, 'viewbox.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="red"/></svg>');
await writeFile(path.join(root, 'binary.dat'), Buffer.from([65, 0, 66, 255]));
await writeFile(path.join(root, 'invalid.txt'), Buffer.from([255, 254, 0]));
await writeFile(path.join(root, 'corrupt.png'), 'not an image');
await writeFile(path.join(root, 'text.txt'), 'ordinary text content');
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let n = 0; n < 16000; n++) {wav.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 440 / 8000) * 8000), 44 + n * 2);}
await writeFile(path.join(root, 'tone.wav'), wav);
await writeFile(path.join(root, 'animation.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const child = spawn(path.join(app, 'LiteCode.exe'), [], { cwd: app, windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server --autoplay-policy=no-user-gesture-required` }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
let browser, page;
const errors = [], checks = [];
try {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {throw new Error(`App exited ${child.exitCode}: ${log}`);}
    if (await fetch(`${endpoint}/json/version`).then(r => r.ok).catch(() => false)) {break;}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.waitForURL('http://localhost:1420/**', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('file-tree-container').waitFor({ timeout: 60000 });
  const urls = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('resource').flatMap(entry => {
    const match = new URL(entry.name).pathname.match(/^\/src\/(documents|store|bridge)\.ts$/);
    return match ? [[match[1], entry.name]] : [];
  })));
  async function action(module, method, ...args) {
    return page.evaluate(async ({ url, method, args }) => (await import(url))[method](...args), { url: urls[module], method, args });
  }
  const open = (name, options = {}) => action('documents', 'openPath', path.join(root, name), { pinned: true, ...options });
  const screenshot = async name => {
    await page.locator('.media-loading').waitFor({ state: 'hidden' });
    return page.screenshot({ path: path.join(run, `${name}.png`) });
  };
  const state = () => page.evaluate(async url => {
    const s = (await import(url)).useApp.getState(); return { docs: s.docs, groups: s.groups, activeGroup: s.activeGroup, notice: s.notice };
  }, urls.store);
  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#0078d4'; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#fff'; ctx.font = '36px sans-serif'; ctx.fillText('LiteCode', 38, 140);
    const images = Object.fromEntries(['png', 'jpeg', 'webp'].map(type => [type, canvas.toDataURL(`image/${type}`).split(',')[1]]));
    return { images };
  });
  for (const [type, bytes] of Object.entries(fixtures.images)) {await writeFile(path.join(root, `image #+中文.${type === 'jpeg' ? 'JpEg' : type}`), Buffer.from(bytes, 'base64'));}
  await copyFile(new URL('./fixtures/media.webm', import.meta.url), path.join(root, 'movie.webm'));
  const bitmap = Buffer.alloc(58); bitmap.write('BM'); bitmap.writeUInt32LE(58, 2); bitmap.writeUInt32LE(54, 10); bitmap.writeUInt32LE(40, 14); bitmap.writeInt32LE(1, 18); bitmap.writeInt32LE(1, 22); bitmap.writeUInt16LE(1, 26); bitmap.writeUInt16LE(24, 28); bitmap[54] = 255;
  await writeFile(path.join(root, 'pixel.bmp'), bitmap);
  const png = Buffer.from(fixtures.images.png, 'base64'); const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await writeFile(path.join(root, 'icon.ico'), Buffer.concat([ico, png]));

  const imageId = await open('image #+中文.png');
  await page.getByRole('button', { name: 'Image Zoom: Whole Image', exact: true }).waitFor();
  assert.match(await page.locator('.status-right').innerText(), /256x256/);
  assert.doesNotMatch(await page.locator('.status-right').innerText(), /Ln 1/);
  await action('documents', 'refreshDocuments');
  await page.locator('.media-loading').waitFor({ state: 'hidden' });
  await page.locator('.image-stage img').click();
  await page.getByRole('button', { name: 'Image Zoom: 150%', exact: true }).waitFor();
  await screenshot('01-image');
  await page.locator('.image-stage img').click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Image Zoom: 100%', exact: true }).waitFor();
  await page.locator('.image-viewport').press('+');
  await page.getByRole('button', { name: 'Image Zoom: 150%', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Image Zoom: 150%', exact: true }).click();
  await page.getByRole('menuitem', { name: '200%', exact: true }).click();
  await page.getByRole('button', { name: 'Image Zoom: 200%', exact: true }).waitFor();
  await page.locator('.image-viewport').hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, 100); await page.keyboard.up('Control');
  await page.getByRole('button', { name: 'Image Zoom: 185%', exact: true }).waitFor();
  const firstGroup = (await state()).activeGroup;
  await action('documents', 'patchMediaView', firstGroup, imageId, { scale: 10 });
  await page.waitForFunction(() => document.querySelector('.image-viewport').scrollWidth > document.querySelector('.image-viewport').clientWidth);
  await page.locator('.image-viewport').evaluate(el => el.scrollTo(180, 120));
  await page.waitForFunction(() => Math.abs(document.querySelector('.image-viewport').scrollTop - 120) < 1);
  await open('text.txt'); await action('documents', 'showDocument', imageId);
  await page.waitForFunction(() => Math.abs(document.querySelector('.image-viewport')?.scrollTop - 120) < 1);
  await action('documents', 'patchMediaView', firstGroup, imageId, { scale: 1.5, scrollLeft: 0, scrollTop: 0 });
  checks.push('Real protocol image loading, Unicode/space/#/+ paths, original dimensions, status bar, click/Ctrl-click and keyboard zoom');
  checks.push('Zoom picker, Ctrl+wheel and scroll position restored across tabs');
  for (const name of ['image #+中文.JpEg', 'image #+中文.webp', 'animation.gif', 'pixel.bmp', 'icon.ico']) {
    await open(name); await page.getByRole('button', { name: 'Image Zoom: Whole Image', exact: true }).waitFor();
  }
  checks.push('JPEG (mixed-case extension), WebP, GIF, BMP and ICO decoding');
  const svgId = await open('icon.svg');
  await page.getByRole('button', { name: 'Image Zoom: Whole Image', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Select SVG editor', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Text Editor', exact: true }).click();
  await page.locator('.editor-group.focused .monaco-host').waitFor({ state: 'visible' });
  const modified = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>';
  await page.evaluate(async ({ url, id, text }) => {
    const m = (await import(url)).models.get(id); m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null); m.pushStackElement();
  }, { url: urls.documents, id: svgId, text: modified });
  await page.getByRole('button', { name: 'Select SVG editor', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Image Preview', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.status-right').textContent.includes('80x40'));
  assert.equal((await state()).docs[svgId].dirty, true);
  assert.doesNotMatch(await readFile(path.join(root, 'icon.svg'), 'utf8'), /width="80"/);
  await screenshot('02-svg');
  const splitId = await action('documents', 'splitGroup');
  await action('documents', 'patchMediaView', splitId, svgId, { mode: 'text' });
  assert.equal(await page.locator('.media-preview').count(), 1);
  assert.equal(await page.locator('.monaco-host:visible').count(), 1);
  checks.push('SVG defaults to image; source edit previews unsaved buffer without saving; split views remain independent');
  await action('documents', 'checkpoint');
  await page.reload(); await page.locator('file-tree-container').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2);
  assert.equal((await state()).docs[svgId].dirty, true);
  assert.equal(await page.locator('.media-preview').count(), 1);
  checks.push('Session restore keeps media tabs, SVG modes and unsaved source');
  await action('documents', 'closeDocument', svgId, splitId);
  await open('viewbox.svg'); await page.getByRole('button', { name: 'Image Zoom: Whole Image', exact: true }).waitFor();
  const before = await page.locator('.image-stage img').boundingBox();
  await page.locator('.image-stage img').click();
  const after = await page.locator('.image-stage img').boundingBox(); assert.ok(after.width > before.width);
  checks.push('ViewBox-only SVG zoom changes rendered dimensions');
  await open('binary.dat'); await page.getByText('The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.', { exact: true }).waitFor();
  await screenshot('03-binary');
  await open('invalid.txt'); await page.locator('.binary-message').waitFor();
  await open('corrupt.png'); await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  checks.push('Binary and unsupported encoding editor UI; corrupt image shows retry');
  await open('binary.dat');
  const warningSize = await page.locator('.binary-message>.codicon').evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(warningSize, '64px');
  const audioId = await open('tone.wav'); await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  assert.equal(await page.locator('audio').evaluate(el => el.autoplay), false);
  await page.locator('audio').evaluate(el => el.play());
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
  const videoId = await open('movie.webm'); await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  await page.locator('video').evaluate(el => el.play());
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
  await page.locator('video').evaluate(el => { el.currentTime = 0.8; });
  await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 0.8);
  await screenshot('04-video');
  checks.push('Real WebView2 WAV/WebM playback, metadata loading and seeking');
  await action('documents', 'showDocument', imageId);
  const updatedPng = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 32, 16); return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(path.join(root, 'image #+中文.png'), Buffer.from(updatedPng, 'base64'));
  await action('documents', 'refreshDocuments');
  await page.waitForFunction(() => document.querySelector('.status-right').textContent.includes('32x16'));
  checks.push('External image writes refresh dimensions and actual file size');
  await rename(path.join(root, 'image #+中文.png'), path.join(root, 'renamed.png'));
  await action('documents', 'renameDocuments', [{ from: path.join(root, 'image #+中文.png'), to: path.join(root, 'renamed.png') }]);
  await page.getByRole('button', { name: 'Image Zoom: 150%', exact: true }).waitFor();
  await unlink(path.join(root, 'renamed.png')); await action('documents', 'refreshDocuments');
  await page.getByText('The file could not be found. It may have been moved or deleted.', { exact: true }).waitFor();
  checks.push('Media rename preserves tab and zoom; deletion displays file missing state');
  const backup = JSON.parse(await readFile(path.join(data, 'session-main.json'), 'utf8'));
  for (const id of [audioId, videoId]) {assert.equal(backup.documents.find(d => d.id === id).text, '');}
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ checks, errors, log }, null, 2));
  console.log(JSON.stringify({ run, checks, errors }, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  if (page) {console.error(JSON.stringify(await page.evaluate(() => ({ images: [...document.images].map(i => ({ src: i.src, width: i.naturalWidth, complete: i.complete, html: i.outerHTML })), resources: performance.getEntriesByType('resource').filter(e => e.name.includes('media.localhost')).map(e => ({ name: e.name, duration: e.duration })), preview: document.querySelector('.media-preview')?.outerHTML })).catch(() => null), null, 2));}
  console.error(log); throw error;
} finally {
  await browser?.close().catch(() => {}); child.kill();
}
