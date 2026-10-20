import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Run against npm run dev. Use the real UI and Worker with an isolated filesystem bridge.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(20_000);
const errors = []; const urls = {}; const measurements = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => { const match = new URL(request.url()).pathname.match(/^\/src\/(store|documents)\.ts$/); if (match) {urls[match[1]] = request.url();} });
await page.addInitScript(() => {
  window.__renders = {}; window.__profile = []; window.__workerMessages = [];
  window.__workerDelay = 0; window.__inputFrames = []; window.__settled = [];
  window.__treeRequested = 0; window.__treeFinished = 0; window.__longTasks = [];
  new PerformanceObserver(list => { window.__longTasks.push(...list.getEntries().map(entry => entry.duration)); }).observe({ type: 'longtask', buffered: false });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes('/tree.worker')) {
        this.tree = true;
        this.addEventListener('message', () => { window.__treeFinished++; });
      }
      if (!String(args[0]).includes('quickFiles.worker')) {return;}
      this.addEventListener('message', event => {
        if (!window.__workerDelay || event.delayed) {return;}
        event.stopImmediatePropagation();
        setTimeout(() => { const next = new MessageEvent('message', { data: event.data }); next.delayed = true; this.dispatchEvent(next); }, window.__workerDelay);
      });
    }
    postMessage(message, ...args) {
      if (this.tree) {window.__treeRequested++;}
      if (message?.kind) {window.__workerMessages.push({ kind: message.kind, query: message.query });}
      return super.postMessage(message, ...args);
    }
  };
  let started = null;
  document.addEventListener('input', event => {
    if (event.target.getAttribute('aria-label') !== 'Quick Access') {return;}
    started = performance.now();
    const start = started;
    requestAnimationFrame(() => window.__inputFrames.push(performance.now() - start));
  }, true);
  new MutationObserver(() => {
    if (started === null || document.querySelector('[aria-label="Quick Access"]')?.getAttribute('aria-busy') !== 'false') {return;}
    window.__settled.push(performance.now() - started); started = null;
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
});

for (const [file, names] of Object.entries({ App: ['App'], Explorer: ['Explorer'], EditorGroup: ['EditorGroup'], QuickOpen: ['QuickOpen', 'QuickResults'] })) {
  await page.route(`**/src/${file}.tsx*`, async route => {
    const response = await route.fetch(); let body = await response.text();
    for (const name of names) {
      const expression = new RegExp(`(function ${name}\\([^)]*\\) \\{)`);
      assert.ok(expression.test(body), `Instrument ${name}`);
      body = body.replace(expression, `$1 window.__renders.${name} = (window.__renders.${name} || 0) + 1;`);
    }
    if (file === 'App') {
      const react = body.match(/import (__vite__cjsImport\d+_react) from /)?.[1];
      assert.ok(react, 'Find React import for Profiler');
      const expression = /export default function App\(/;
      assert.ok(expression.test(body), 'Instrument root Profiler');
      body = body.replace(expression, 'function App(');
      body += `\nexport default function VerifiedApp() { return ${react}.createElement(${react}.Profiler, { id: 'workbench', onRender: (id, phase, actualDuration) => window.__profile.push({id, phase, actualDuration}) }, ${react}.createElement(App)); }`;
    }
    await route.fulfill({ response, body });
  });
}
await page.route('**/src/bridge.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() { return {root:null,documents:[],session:{},recent:['C:/quick-fixture'],settings:{},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command, args) {
 if (command === 'inspect_file') return {kind:'text',size:20,stamp:'fixture'};
 if (command === 'read_document') { window.__opened = args.path; return {text:'one\\ntwo\\nthree',encoding:'utf8',eol:'LF',revision:'fixture'}; }
 if (command === 'explicit_open') return args.path;
 if (command === 'language_document' || command === 'search_cancel' || command === 'search_ack') return;
 if (command === 'search_start') { args.onBatch.onmessage({requestId:args.requestId,matches:[],errors:[],done:true}); return; }
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const input = page.getByRole('combobox', { name: 'Quick Access' });
const ready = () => page.waitForFunction(() => document.querySelector('[aria-label="Quick Access"]')?.getAttribute('aria-busy') === 'false');
async function state(patch) { await page.evaluate(async ({ url, patch }) => { (await import(url)).setApp(patch); }, { url: urls.store, patch }); }
async function open(query = '') { await state({ quick: query }); await input.waitFor(); await ready(); }
async function fill(query) { await input.fill(query); await ready(); }
async function close() { await page.keyboard.press('Escape'); await input.waitFor({ state: 'hidden' }); }
function p95(samples) { return samples.slice().sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]; }
async function workspace(count, opened) {
  await page.evaluate(async ({ url, count, opened }) => {
    const paths = Array.from({ length: count }, (_, i) => `packages/module-${i % 97}/src/Component${i}.tsx`);
    paths.push('src/Alpha.ts', 'src/Beta.ts', 'src/中文.ts');
    const docs = Object.fromEntries(paths.slice(0, opened).map((path, i) => [String(i), { id: String(i), path: `C:/quick-fixture/${path}`, name: path.split('/').at(-1), language: 'typescript', version: 1, dirty: false }]));
    (await import(url)).setApp({ root: 'C:/quick-fixture', treeRoot: 'C:/quick-fixture', tree: { paths, git: [], branch: null, warnings: [], truncated: false }, docs });
  }, { url: urls.store, count, opened });
}
try {
  await page.goto('http://localhost:1420'); await page.locator('.editor-group').waitFor({ state: 'attached' });
  await workspace(1000, 0); await open(); await fill('Alpha');
  assert.equal(await page.locator('.quick-label').first().textContent(), 'Alpha.ts');
  assert.deepEqual(await page.locator('.quick-label mark').allTextContents(), ['A', 'l', 'p', 'h', 'a']);
  assert.equal(await page.evaluate(async url => (await import(url)).useApp.getState().quick, urls.store), '', 'Typing stays local');
  await page.evaluate(() => { window.__workerMessages = []; });
  await fill('Alpha:2:1');
  assert.equal(await page.evaluate(() => window.__workerMessages.filter(m => m.kind === 'search').length), 0, 'Line suffix does not repeat matching');
  await page.keyboard.press('Enter'); await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__opened), 'C:/quick-fixture/src/Alpha.ts');
  const position = await page.evaluate(async url => (await import(url)).editor()?.getPosition(), urls.documents);
  assert.equal(position.lineNumber, 2);

  await open(); await fill('Alpha');
  await page.evaluate(() => { window.__workerDelay = 150; });
  await input.fill('Beta'); await page.keyboard.press('Enter');
  await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__opened), 'C:/quick-fixture/src/Beta.ts', 'Immediate Enter opens the latest query');
  await page.evaluate(() => { window.__workerDelay = 0; });

  await open(); await page.evaluate(() => { window.__workerDelay = 150; });
  await input.fill('Alpha'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await input.waitFor({ state: 'hidden' });
  await open('Beta');
  assert.equal(await page.locator('.quick-label').first().textContent(), 'Beta.ts', 'Old results cannot overwrite a reopened popup');
  await page.evaluate(() => { window.__workerDelay = 0; });
  await input.dispatchEvent('compositionstart');
  await input.fill('中文'); await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await input.isVisible(), true, 'IME Enter does not open a file');
  await input.dispatchEvent('compositionend'); await ready();
  assert.equal(await page.locator('.quick-label').first().textContent(), '中文.ts');
  await close();

  await open('?'); await page.locator('.quick-item').first().click();
  assert.equal(await input.inputValue(), '>');
  await fill('>Go to File'); assert.ok(await page.locator('.quick-item').count());
  await fill('view Search'); assert.equal(await page.locator('.quick-label').first().textContent(), 'Search');
  await fill('recent'); assert.equal(await page.locator('.quick-label').first().textContent(), 'quick-fixture');
  await fill('edt '); assert.ok(await page.locator('.quick-item').count());
  await fill(':2'); assert.match(await page.locator('.quick-label').first().textContent(), /line 2/);
  await fill('%needle'); await page.waitForTimeout(250); await close();

  await open('@nothing'); assert.equal(await input.inputValue(), '@nothing');
  await fill('#nothing'); await close();
  await open('D:\\outside\\Absolute.txt:2'); await page.keyboard.press('Enter'); await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__opened), 'D:\\outside\\Absolute.txt');

  await open('Alpha');
  await page.evaluate(() => { window.__workerMessages = []; });
  await page.evaluate(async url => {
    const { useApp, setApp } = await import(url); const s = useApp.getState();
    const [id, doc] = Object.entries(s.docs)[0]; setApp({ docs: { ...s.docs, [id]: { ...doc, version: doc.version + 1 } } });
  }, urls.store);
  assert.deepEqual(await page.evaluate(() => window.__workerMessages), [], 'Buffer metadata changes do not rebuild the file index');

  // A workspace switch invalidates both a running query and a queued Enter.
  await page.evaluate(() => { window.__workerDelay = 150; });
  await input.fill('Beta'); await page.keyboard.press('Enter');
  await state({ root: 'C:/next-fixture', treeRoot: 'C:/next-fixture', tree: { paths: ['Beta.ts', 'New.ts'], git: [], branch: null, warnings: [], truncated: false } });
  await ready(); assert.equal(await input.isVisible(), true);
  assert.equal(await page.locator('.quick-description').first().textContent(), '');
  await page.evaluate(() => { window.__workerDelay = 0; });
  await fill('New');
  const groupCount = await page.locator('.editor-group').count();
  await page.keyboard.press('Control+Enter'); await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__opened), 'C:/next-fixture/New.ts');
  assert.equal(await page.locator('.editor-group').count(), groupCount + 1, 'Ctrl+Enter opens to the side');

  await open('UniqueRefresh999');
  assert.equal(await page.locator('.quick-label').count(), 0);
  await state({ tree: { paths: ['Beta.ts', 'New.ts', 'UniqueRefresh999.txt'], git: [], branch: null, warnings: [], truncated: false } });
  await ready(); assert.equal(await page.locator('.quick-label').first().textContent(), 'UniqueRefresh999.txt', 'A new file appears after a directory refresh');
  const active = await page.evaluate(async url => { const s = (await import(url)).useApp.getState(); return s.groups.find(g => g.id === s.activeGroup)?.active; }, urls.store);
  await page.keyboard.press('Alt+Enter'); await input.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__opened), 'C:/next-fixture/UniqueRefresh999.txt');
  assert.equal(await page.evaluate(async url => { const s = (await import(url)).useApp.getState(); return s.groups.find(g => g.id === s.activeGroup)?.active; }, urls.store), active, 'Alt+Enter preserves the active editor');

  for (const count of [10_000, 50_000, 200_000]) {
    for (const opened of [0, 100]) {
      const indexStarted = performance.now(); await workspace(count, opened); await open();
      const indexAndOpenMs = performance.now() - indexStarted;
      await page.waitForFunction(() => window.__treeRequested === window.__treeFinished);
      await fill('Component');
      await page.evaluate(() => { window.__inputFrames = []; window.__settled = []; window.__profile = []; window.__renders = {}; window.__longTasks = []; });
      for (let i = 0; i < 30; i++) {await fill(i % 2 ? `Component${count - i - 1}` : `module-${i}/c`);}
      await page.waitForTimeout(50);
      const result = await page.evaluate(() => ({ inputFrames: window.__inputFrames, settled: window.__settled, profile: window.__profile, renders: window.__renders, longTasks: window.__longTasks }));
      assert.ok(result.profile.length, 'React Profiler captures commits');
      for (const name of ['App', 'Explorer', 'EditorGroup']) {assert.equal(result.renders[name] ?? 0, 0, `${name} does not render on file input`);}
      const measurement = { count, opened, indexAndOpenMs, inputFrameP95Ms: p95(result.inputFrames), resultP95Ms: p95(result.settled), maxReactCommitMs: Math.max(...result.profile.map(p => p.actualDuration)), renders: result.renders, longTasks: result.longTasks };
      measurements.push(measurement); console.log(JSON.stringify(measurement));
      assert.ok(measurement.inputFrameP95Ms <= 50, 'Input-to-next-frame P95 <= 50ms');
      assert.ok(measurement.resultP95Ms <= 200, 'Result P95 <= 200ms');

      // Hold a response to prove local typing can skip an unchanged list.
      await page.evaluate(() => { window.__workerDelay = 250; });
      await input.fill('Component'); await page.waitForTimeout(30);
      const before = await page.evaluate(() => window.__renders.QuickResults ?? 0);
      await input.pressSequentially('1234', { delay: 5 });
      const after = await page.evaluate(() => window.__renders.QuickResults ?? 0);
      assert.equal(after, before, 'Unchanged results skip rendering during typing');
      await ready(); await page.evaluate(() => { window.__workerDelay = 0; });
      await close();
    }
  }
  assert.deepEqual(errors, []);
  await mkdir('.verification/quick-open', { recursive: true });
  await writeFile('.verification/quick-open/results.json', JSON.stringify({ environment: await page.evaluate(() => navigator.userAgent), measurements, errors }, null, 2));
  console.log('PASS: local input, Profiler, real Worker, sorting/highlights, suffix, immediate Enter, cancellation/reopen, IME and quick-access modes');
} catch (error) {
  console.error(JSON.stringify({ errors, ...await page.evaluate(() => ({ ui: document.querySelector('.quick-open')?.textContent, messages: window.__workerMessages.slice(-6) })) }));
  throw error;
} finally { await browser.close(); }
