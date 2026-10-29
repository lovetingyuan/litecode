import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Exercise real Monaco and React; isolate native I/O in an in-memory fixture.
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
const urls = {};
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  const match = new URL(request.url()).pathname.match(
    /^\/src\/(editor\/(monaco|documents|languages)|store\/store|core\/commands)\.ts$/,
  );
  if (match) {
    urls[match[1]] = request.url();
  }
});
const documents = [
  {
    name: "spaces.ts",
    text: "function test() {\n  const a = 1;\n  return a;\n}\n",
    language: "typescript",
  },
  {
    name: "tabs.ts",
    text: "function test() {\n\tconst a = 1;\n\treturn a;\n}\n",
    language: "typescript",
  },
  { name: "README.md", text: "# Example\n", language: "markdown" },
].map((doc) => ({
  ...doc,
  id: `fixture:${doc.name}`,
  path: `C:/fixture/${doc.name}`,
  encoding: "utf8",
  dirty: false,
  version: 1,
  revision: "one",
}));
const files = {
  "C:/user/settings.json":
    '{\n  // keep user comment\n  "terminal.integrated.fontSize": 17,\n  "editor.fontSize": 15\n}\n',
  "C:/fixture/.litecode/settings.json":
    '{\n  // keep workspace comment\n  "files.autoSave": "off",\n  "editor.tabSize": 2\n}\n',
  "C:/fixture/ordinary.json": '{"z":0,"a":1}',
  "C:/fixture/.vscode/settings.json": '{"z":0,"editor.tabSize":2}',
  "C:/user/keybindings.json": '[{"key":"ctrl+s","command":"save"}]',
};
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({onmessage:fn});
const files = ${JSON.stringify(files)};
window.settingsWrites = [];
window.unexpectedSettingsCalls = [];
export async function bootstrap() { return ${JSON.stringify({
      root: null,
      documents,
      session: {
        groups: [
          {
            id: "one",
            tabs: documents.map((doc) => doc.id),
            active: documents[0].id,
            preview: null,
            views: {},
          },
        ],
        activeGroup: "one",
        sidebar: "",
      },
      settings: {},
      recent: [],
      keybindings: [],
      dataDir: "C:/user",
      warnings: [],
    })}; }
export async function call(command, args) {
  if (command === 'settings_path') return 'C:/user/settings.json';
  if (command === 'inspect_file') return {kind:'text',size:100,stamp:'one'};
  if (command === 'read_document') return {text:files[args.path],encoding:'utf8',eol:'LF',revision:'one'};
  if (command === 'save_document') { window.settingsWrites.push(args); files[args.path]=args.text; return 'saved'; }
  if (command === 'configuration') return {settings:{},keybindings:[]};
  if (command === 'read_workspace_directory') return {root:args.expectedRoot,session:1,directory:args.directory,paths:[],warnings:[]};
  if (command === 'workspace_git_status') return {root:args.expectedRoot,session:1,git:[],branch:null,warnings:[]};
  window.unexpectedSettingsCalls.push(command);
  throw new Error('Unexpected fixture command: '+command);
}`,
  }),
);
try {
  await page.goto("http://localhost:1420/");
  await page.locator(".monaco-editor .view-lines").waitFor();
  await page.evaluate(async (urls) => {
    const { monaco } = await import(urls["editor/monaco"]);
    const docs = await import(urls["editor/documents"]);
    const store = await import(urls["store/store"]);
    const commands = await import(urls["core/commands"]);
    window.settingsFixture = { monaco, docs, store, commands };
  }, urls);
  const evaluate = (fn, arg) => page.evaluate(fn, arg);
  const defaults = await evaluate(() => {
    const { monaco, docs } = window.settingsFixture;
    const e = docs.editors.get("one");
    const option = monaco.editor.EditorOption;
    return {
      smooth: e.getOption(option.smoothScrolling),
      guides: e.getOption(option.guides),
      spaces: docs.models.get("fixture:spaces.ts").getOptions(),
      tabs: docs.models.get("fixture:tabs.ts").getOptions(),
    };
  });
  assert.equal(defaults.smooth, true);
  assert.equal(defaults.guides.bracketPairs, true);
  assert.equal(defaults.spaces.tabSize, 2);
  assert.equal(defaults.tabs.insertSpaces, false);
  await page.getByRole("button", { name: "Spaces: 2", exact: true }).waitFor();
  await evaluate(() =>
    window.settingsFixture.store.setApp({
      settings: {
        "editor.lineNumbers": "relative",
        "editor.renderWhitespace": "all",
        "editor.rulers": [80, { column: 100, color: "#ff0000" }],
        "editor.wordWrap": "bounded",
        "editor.wordWrapColumn": 100,
        "editor.fontWeight": 550,
        "editor.smoothScrolling": false,
        "editor.folding": false,
        "editor.hover.enabled": "off",
        "editor.quickSuggestions": false,
        "editor.inlayHints.enabled": "off",
        "editor.cursorStyle": "block",
        "editor.detectIndentation": false,
        "editor.tabSize": 8,
        "editor.insertSpaces": false,
      },
    }),
  );
  await page.waitForFunction(() => {
    const { monaco, docs } = window.settingsFixture;
    return docs.editors.get("one").getOption(monaco.editor.EditorOption.wordWrap) === "bounded";
  });
  const live = await evaluate(() => {
    const { monaco, docs } = window.settingsFixture;
    const e = docs.editors.get("one");
    const option = monaco.editor.EditorOption;
    return Object.fromEntries(
      [
        "lineNumbers",
        "renderWhitespace",
        "rulers",
        "wordWrapColumn",
        "fontWeight",
        "smoothScrolling",
        "folding",
        "hover",
        "quickSuggestions",
        "inlayHints",
        "cursorStyle",
      ].map((name) => [name, e.getOption(option[name])]),
    );
  });
  assert.equal(live.lineNumbers.renderType, 2);
  assert.equal(live.renderWhitespace, "all");
  assert.deepEqual(
    live.rulers.map((ruler) => ruler.column),
    [80, 100],
  );
  assert.equal(live.wordWrapColumn, 100);
  assert.equal(live.fontWeight, "550");
  assert.equal(live.smoothScrolling, false);
  assert.equal(live.folding, false);
  assert.equal(live.hover.enabled, "off");
  assert.equal(live.quickSuggestions.other, "off");
  assert.equal(live.inlayHints.enabled, "off");
  assert.equal(live.cursorStyle, 2);
  await page.getByRole("button", { name: "Tabs: 8", exact: true }).waitFor();
  await evaluate(() => window.settingsFixture.docs.splitGroup("one"));
  await page.waitForFunction(() => window.settingsFixture.docs.editors.size === 2);
  assert.equal(
    await evaluate(() => {
      const { docs, monaco } = window.settingsFixture;
      return (
        [...docs.editors.values()].every(
          (e) => e.getOption(monaco.editor.EditorOption.wordWrap) === "bounded",
        ) &&
        [...docs.models.values()].every(
          (m) => m.getOptions().tabSize === 8 && !m.getOptions().insertSpaces,
        )
      );
    }),
    true,
  );
  assert.equal(
    await evaluate(() => {
      const { docs, monaco } = window.settingsFixture;
      const model = docs.models.get("fixture:tabs.ts");
      monaco.editor.setModelLanguage(model, "plaintext");
      return model.getOptions().tabSize;
    }),
    8,
    "Changing language must preserve the configured indentation",
  );
  await evaluate(() => {
    const { docs, store } = window.settingsFixture;
    store.setApp({
      settings: {
        ...store.useApp.getState().settings,
        "editor.folding": true,
        "editor.minimap.enabled": true,
      },
    });
    docs.patchDoc("fixture:spaces.ts", { large: true });
  });
  await page.waitForFunction(() => {
    const { docs, monaco } = window.settingsFixture;
    return [...docs.editors.values()].every(
      (e) =>
        !e.getOption(monaco.editor.EditorOption.minimap).enabled &&
        !e.getOption(monaco.editor.EditorOption.folding),
    );
  });
  await evaluate(() => window.settingsFixture.docs.patchDoc("fixture:spaces.ts", { large: false }));
  await evaluate(() => window.settingsFixture.store.setApp({ settings: {} }));
  await page.getByRole("button", { name: "Spaces: 2", exact: true }).waitFor();
  await evaluate(() =>
    window.settingsFixture.store.setApp({ settings: { "breadcrumbs.enabled": false } }),
  );
  await page.getByRole("navigation", { name: "File breadcrumbs" }).waitFor({ state: "hidden" });
  await evaluate(() =>
    window.settingsFixture.docs.showDocument("fixture:README.md", { pinned: true }),
  );
  await page.getByRole("button", { name: "Select Markdown editor" }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "File breadcrumbs" }).count(), 0);
  await evaluate(() => {
    window.settingsFixture.store.setApp({ settings: {} });
    window.dispatchEvent(
      new CustomEvent("show-diff", {
        detail: {
          title: "Whitespace comparison",
          before: "const a = 1;\n",
          after: "const a = 1;   \n",
          language: "typescript",
        },
      }),
    );
  });
  await page.locator(".monaco-diff-editor.side-by-side").waitFor();
  await page.waitForFunction(
    () => window.settingsFixture.monaco.editor.getDiffEditors()[0]?.getLineChanges()?.length === 0,
  );
  await evaluate(() =>
    window.settingsFixture.store.setApp({
      settings: {
        "diffEditor.renderSideBySide": false,
        "diffEditor.ignoreTrimWhitespace": false,
      },
    }),
  );
  await page.locator(".monaco-diff-editor.side-by-side").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => window.settingsFixture.monaco.editor.getDiffEditors()[0]?.getLineChanges()?.length > 0,
  );
  await page.getByRole("button", { name: "Close Compare", exact: true }).click();
  await evaluate(() => {
    const { docs, store } = window.settingsFixture;
    store.setApp({ settings: { "workbench.editor.enablePreview": false }, root: "C:/fixture" });
    docs.showDocument("fixture:spaces.ts");
    docs.showDocument("fixture:tabs.ts");
  });
  assert.equal(
    await evaluate(() =>
      window.settingsFixture.store.useApp.getState().groups.every((g) => g.preview === null),
    ),
    true,
  );

  // Opening settings organizes the buffer; saving does not reorganize hand edits.
  const workspace = await evaluate(async () => {
    const { docs } = window.settingsFixture;
    const id = await docs.openPath("C:/fixture/.litecode/settings.json", { pinned: true });
    const m = docs.models.get(id);
    const organized = m.getValue();
    m.undo();
    const original = m.getValue();
    m.redo();
    m.pushEditOperations(
      [],
      [{ range: m.getFullModelRange(), text: '{"files.autoSave":"off","editor.tabSize":3}' }],
      () => null,
    );
    await docs.save(id);
    return { organized, original, saved: window.settingsWrites.at(-1).text };
  });
  assert.ok(
    workspace.organized.indexOf('"editor.tabSize"') <
      workspace.organized.indexOf('"files.autoSave"'),
  );
  assert.ok(workspace.organized.includes("keep workspace comment"));
  assert.ok(!workspace.organized.includes('"editor.fontSize"'));
  assert.equal(workspace.original, files["C:/fixture/.litecode/settings.json"]);
  assert.equal(workspace.saved, '{"files.autoSave":"off","editor.tabSize":3}');
  for (const path of [
    "C:/fixture/ordinary.json",
    "C:/fixture/.vscode/settings.json",
    "C:/user/keybindings.json",
  ]) {
    assert.equal(
      await evaluate(async (path) => {
        const { docs } = window.settingsFixture;
        return docs.models.get(await docs.openPath(path, { pinned: true })).getValue();
      }, path),
      files[path],
    );
  }
  const user = await evaluate(async () => {
    const { commands, docs, store } = window.settingsFixture;
    await commands.execute("workbench.action.openSettingsJson");
    const id = store.useApp
      .getState()
      .groups.find((g) => g.id === store.useApp.getState().activeGroup).active;
    const text = docs.models.get(id).getValue();
    await commands.execute("workbench.action.openSettingsJson");
    return { text, repeated: docs.models.get(id).getValue(), writes: window.settingsWrites.length };
  });
  assert.equal(user.text, user.repeated);
  assert.ok(user.text.includes("keep user comment"));
  assert.ok(user.text.includes('"editor.cursorStyle"'));
  assert.equal(user.writes, 1);
  assert.deepEqual(await evaluate(() => window.unexpectedSettingsCalls), []);
  assert.equal(await evaluate(() => window.settingsFixture.store.useApp.getState().notice), null);
  const schema = JSON.parse(await readFile("src/config/settings-schema.json", "utf8"));
  await mkdir(".verification/settings", { recursive: true });
  await page.screenshot({ path: ".verification/settings/grouped-settings.png" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      settings: Object.keys(schema.properties).length,
      defaults: "preserved",
      liveEditor: "passed",
      split: "passed",
      indentation: "passed",
      largeFiles: "passed",
      diff: "passed",
      breadcrumbs: "passed",
      settingsOrganizing: "passed",
      errors,
    }),
  );
} finally {
  await browser.close();
}
