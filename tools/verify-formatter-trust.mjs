// Requires a Debug build, npm run build:tools, Node.js and rustfmt.
// All application data, code execution markers and trust decisions are isolated.
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const run = path.resolve("tmp", ".verification", `formatter-trust-${Date.now()}`);
const app = path.join(run, "app");
const data = path.join(app, "data");
const loose = path.join(run, "loose");
const workspace = path.join(run, "workspace");
const file = path.join(loose, "a.html");
const marker = path.join(run, "script-executed");
const configMarker = path.join(run, "config-executed");
const js = JSON.stringify;
const exists = (filename) =>
  access(filename).then(
    () => true,
    () => false,
  );
// Only this isolated app loses PATH-based Node; positive cases use nodePath.
const runtimeEnv = { ...process.env };
for (const key of Object.keys(runtimeEnv).filter((key) => key.toUpperCase() === "PATH")) {
  const directories = [];
  for (const directory of runtimeEnv[key].split(path.delimiter)) {
    if (
      !(await exists(path.join(directory, "node.exe"))) &&
      !(await exists(path.join(directory, "node")))
    ) {
      directories.push(directory);
    }
  }
  runtimeEnv[key] = directories.join(path.delimiter);
}
for (const folder of [data, loose, workspace, path.join(loose, "node_modules/prettier/bin")]) {
  await mkdir(folder, { recursive: true });
}
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await cp("src-tauri/tools/formatters", path.join(app, "tools/formatters"), { recursive: true });
await writeFile(
  path.join(loose, "node_modules/prettier/package.json"),
  js({ bin: "bin/prettier.cjs" }),
);
// Keep real project tools within this fixture; a later case checks an outside source.
await cp(
  "src-tauri/tools/formatters/node_modules/prettier",
  path.join(workspace, "node_modules/prettier"),
  { recursive: true },
);
await writeFile(file, "<p>original</p>");
await writeFile(path.join(workspace, "a.html"), "<div><p>text</p></div>");
await writeFile(
  path.join(loose, "node_modules/prettier/bin/prettier.cjs"),
  `require('node:fs').writeFileSync(${js(marker)},'executed');console.error('AUDIT_FORMATTER_EXECUTED');process.exit(1);`,
);
await writeFile(
  path.join(run, "prettier.config.cjs"),
  `require('node:fs').writeFileSync(${js(configMarker)},'executed');module.exports={tabWidth:4,htmlWhitespaceSensitivity:'ignore',printWidth:10};`,
);
await writeFile(
  path.join(data, "settings.json"),
  js({
    "files.autoSave": "off",
    "editor.formatOnSave": true,
    "litecode.nodePath": process.execPath,
  }),
);
await writeFile(
  path.join(data, "session-main.json"),
  js({ root: null, documents: [], session: {} }),
);
let vite, child, socket, evaluate;
const checks = [];
const consoleErrors = [];

async function waitFor(check, description) {
  const until = Date.now() + 60_000;
  let last;
  while (Date.now() < until) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: ${last ?? "timeout"}`);
}

try {
  if (!(await fetch("http://localhost:1420").catch(() => null))?.ok) {
    vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"],
      { windowsHide: true, stdio: "ignore" },
    );
    await waitFor(
      async () => (await fetch("http://localhost:1420").catch(() => null))?.ok,
      "Vite startup",
    );
  }
  const appSource = await fetch("http://localhost:1420/src/components/App.tsx").then((r) =>
    r.text(),
  );
  const imports = [...appSource.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  const moduleUrl = (filename) => {
    const url = imports.find((url) => url.split("?")[0] === filename);
    assert.ok(url, `App must import ${filename}`);
    return new URL(url, "http://localhost:1420").href;
  };
  child = spawn(path.join(app, "LiteCode.exe"), [], {
    cwd: app,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...runtimeEnv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9236",
      WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    },
  });
  const target = await waitFor(
    async () =>
      (await fetch("http://127.0.0.1:9236/json/list").then((r) => r.json())).find(
        (target) => target.type === "page" && target.url.includes("1420"),
      ),
    "Isolated WebView startup",
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.text);
    }
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) {
        callback.reject(message.error);
      } else {
        callback.resolve(message.result);
      }
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
      pending.set(key, { resolve, reject, timer });
      socket.send(js({ id: key, method, params }));
    });
  evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  };
  await send("Runtime.enable");
  await waitFor(
    () =>
      evaluate(
        `(async()=>{const {useApp}=await import(${js(moduleUrl("/src/store/store.ts"))});return useApp.getState().ready})()`,
      ),
    "App bootstrap",
  );
  await evaluate(`(async()=>{
    window.audit={};audit.store=await import(${js(moduleUrl("/src/store/store.ts"))});
    audit.docs=await import(${js(moduleUrl("/src/editor/documents.ts"))});
    audit.languages=await import(${js(moduleUrl("/src/editor/languages.ts"))});
    audit.invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args);
    audit.calls=[];const original=window.fetch;window.fetch=async function(input,options){
      const url=new URL(String(input),location.href);
      if(url.hostname==='ipc.localhost'){audit.calls.push({command:decodeURIComponent(url.pathname.slice(1)),args:JSON.parse(options.body)})}
      return original.apply(this,arguments);
    };
    audit.file=await audit.invoke('explicit_open',{path:${js(file)}});
    audit.id=await audit.docs.openPath(audit.file,{pinned:true});
  })()`);
  const rawError = await evaluate(
    `audit.invoke('format_document',{path:audit.file,text:'<p>original</p>',language:'html'}).catch(e=>e)`,
  );
  assert.equal(rawError.code, "formatterTrust");
  assert.equal(path.resolve(rawError.trustPath), loose);
  assert.equal(await exists(marker), false);
  checks.push("Native loose-file formatting rejects untrusted code before spawning a process");

  const click = async (label) => {
    await waitFor(
      () =>
        evaluate(
          `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${js(label)})`,
        ),
      `Dialog button ${label}`,
    );
    const point = await evaluate(
      `(()=>{const r=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${js(label)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  await evaluate(
    `audit.docs.models.get(audit.id).setValue('<p>saved without formatter</p>');audit.done=false;void audit.docs.save(audit.id).then(()=>{audit.done=true})`,
  );
  await click("Cancel");
  await waitFor(() => evaluate(`audit.done`), "Save after refusing trust");
  assert.equal(await exists(marker), false);
  assert.equal(await readFile(file, "utf8"), "<p>saved without formatter</p>");
  checks.push(
    "Refusing the actual save-time trust dialog preserves editing and saves the current buffer without executing the script",
  );

  await evaluate(
    `audit.done=false;void audit.languages.formatModel(audit.docs.models.get(audit.id)).then(()=>{audit.done=true},e=>{audit.error=e;audit.done=true})`,
  );
  await click("Trust Formatters");
  // The ancestor configuration is another source outside the approved loose folder.
  await click("Trust Formatters");
  await waitFor(() => evaluate(`audit.done`), "Approved formatter execution");
  assert.equal(await exists(marker), true);
  assert.equal((await evaluate(`audit.error`)).code, "formatter");
  assert.match((await evaluate(`audit.error`)).message, /AUDIT_FORMATTER_EXECUTED/);
  assert.equal(await exists(configMarker), false);
  checks.push(
    "Only explicit folder and ancestor-config approval allows the harmless project script to execute",
  );

  await evaluate(`(async()=>{
    await audit.languages.stopLanguages();
    await audit.invoke('explicit_open',{path:${js(workspace)}});
    await audit.invoke('open_workspace',{path:${js(workspace)},newWindow:false});
    const boot=await audit.invoke('bootstrap');audit.store.setApp({root:boot.root});
    await audit.invoke('set_workspace_trust',{expectedRoot:boot.root,trusted:true});
  })()`);
  assert.equal(
    (
      await evaluate(
        `audit.invoke('format_document',{path:audit.file,text:'<p>text</p>',language:'html'}).catch(e=>e)`,
      )
    ).code,
    "formatterTrust",
  );
  checks.push(
    "Trusting an unrelated workspace does not authorize an outside file or reuse the loose-window grant",
  );
  const inside = path.join(workspace, "a.html");
  const configError = await evaluate(
    `audit.invoke('format_document',{path:${js(inside)},text:'<div><p>text</p></div>',language:'html'}).catch(e=>e)`,
  );
  assert.equal(configError.code, "formatterTrust");
  assert.equal(path.resolve(configError.trustPath), run);
  assert.equal(await exists(configMarker), false);
  await evaluate(
    `audit.invoke('trust_formatter',{path:${js(inside)},expectedRoot:audit.store.useApp.getState().root,directory:${js(run)}})`,
  );
  const formatted = await evaluate(
    `audit.invoke('format_document',{path:${js(inside)},text:'<div><p>text</p></div>',language:'html'})`,
  );
  assert.match(formatted, /\n {4}<p>/);
  assert.equal(await exists(configMarker), true);
  checks.push(
    "Project Prettier loads an ancestor configuration only after that source is approved and formats correctly",
  );
  await writeFile(
    path.join(workspace, "package.json"),
    js({ prettier: { htmlWhitespaceSensitivity: "ignore", printWidth: 10, tabWidth: 2 } }),
  );
  const packageFormatted = await evaluate(
    `audit.invoke('format_document',{path:${js(inside)},text:'<div><p>text</p></div>',language:'html'})`,
  );
  assert.match(packageFormatted, /\n {2}<p>/);
  checks.push(
    "Explicit Prettier configuration preserves package.json settings and nearest-config precedence",
  );

  const jsoncFile = path.join(workspace, "tsconfig.json");
  const jsoncInput = '{// keep this comment\n"compilerOptions":{"strict":true,},}';
  await writeFile(jsoncFile, jsoncInput);
  await writeFile(
    path.join(workspace, ".editorconfig"),
    "root = true\n[*]\nindent_style = space\nindent_size = 4\nend_of_line = crlf\n",
  );
  await writeFile(path.join(workspace, "package.json"), js({ prettier: { tabWidth: 2 } }));
  const jsoncOutput = await evaluate(
    `audit.invoke('format_document',{path:${js(jsoncFile)},text:${js(jsoncInput)},language:'jsonc'})`,
  );
  assert.match(jsoncOutput, /\r\n {2}"compilerOptions"/);
  assert.ok(jsoncOutput.includes("// keep this comment"));
  await evaluate(
    `(async()=>{audit.jsoncId=await audit.docs.openPath(${js(jsoncFile)},{pinned:true})})()`,
  );
  await waitFor(
    () => evaluate(`audit.docs.editor()?.getModel()===audit.docs.models.get(audit.jsoncId)`),
    "JSONC model attached",
  );
  const manual = await evaluate(`(async()=>{
    await audit.docs.editor().getAction('editor.action.formatDocument').run();
    const m=audit.docs.models.get(audit.jsoncId);const formatted=m.getValue();
    await m.undo();return {formatted,undo:m.getValue()};
  })()`);
  assert.equal(manual.formatted, jsoncOutput);
  assert.equal(manual.undo, jsoncInput);
  await evaluate(`(async()=>{
    audit.store.setApp({settings:{...audit.store.useApp.getState().settings,'editor.formatOnSave':true}});
    await audit.docs.save(audit.jsoncId);
  })()`);
  assert.equal(await readFile(jsoncFile, "utf8"), jsoncOutput);
  await writeFile(
    path.join(workspace, "package.json"),
    js({ prettier: { plugins: ["./missing-plugin.mjs"] } }),
  );
  const failed = await evaluate(`(async()=>{
    const m=audit.docs.models.get(audit.jsoncId);const before=m.getValue();
    const error=await audit.languages.formatModel(m).then(()=>null,e=>e);
    return {before,after:m.getValue(),error};
  })()`);
  assert.equal(failed.error.code, "formatter");
  assert.equal(failed.after, failed.before);
  await writeFile(path.join(workspace, "package.json"), '{"private":true}');
  const editorConfigOnly = await evaluate(
    `audit.invoke('format_document',{path:${js(jsoncFile)},text:${js(jsoncInput)},language:'jsonc'})`,
  );
  // The outer Prettier config supplies tabWidth=4, and EditorConfig supplies CRLF.
  assert.match(editorConfigOnly, /\r\n {4}"compilerOptions"/);
  checks.push(
    "Manual JSONC formatting and format on save honor project options and EOL, undo restores the buffer, and plugin errors preserve it",
  );

  const outside = path.join(run, "outside-prettier.cjs");
  await writeFile(outside, "throw new Error('must not execute');");
  await writeFile(path.join(workspace, "node_modules/prettier/package.json"), js({ bin: outside }));
  // The earlier config grant covers run, so use a fresh context to check tool trust.
  await evaluate(
    `audit.invoke('set_workspace_trust',{expectedRoot:audit.store.useApp.getState().root,trusted:false})`,
  );
  await evaluate(
    `audit.invoke('set_workspace_trust',{expectedRoot:audit.store.useApp.getState().root,trusted:true})`,
  );
  const freshError = await evaluate(
    `audit.invoke('format_document',{path:${js(inside)},text:'<p>text</p>',language:'html'}).catch(e=>e)`,
  );
  assert.equal(freshError.code, "formatterTrust");
  assert.equal(path.resolve(freshError.trustPath), run);
  checks.push("A project Prettier executable outside the workspace needs its own source approval");
  const rust = path.join(workspace, "a.rs");
  await writeFile(rust, "fn main(){let x=1;}");
  const rustfmt = await evaluate(
    `audit.invoke('format_document',{path:${js(rust)},text:'fn main(){let x=1;}',language:'rust'})`,
  );
  assert.match(rustfmt, /let x = 1;/);
  checks.push("Rustfmt still accepts the pinned empty default");

  // Use an existing external JSON file without writing outside tmp or inheriting
  // this repository's dev Prettier through the fixture's ancestor directories.
  const npmManifest = path.join(path.dirname(process.execPath), "node_modules/npm/package.json");
  await access(npmManifest);
  for (let directory = path.dirname(npmManifest); ; directory = path.dirname(directory)) {
    assert.equal(await exists(path.join(directory, "node_modules/prettier")), false);
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  await evaluate(`(async()=>{
    await audit.invoke('explicit_open',{path:${js(npmManifest)}});
    await audit.invoke('trust_formatter',{path:${js(npmManifest)},expectedRoot:audit.store.useApp.getState().root,directory:${js(path.dirname(npmManifest))}});
  })()`);
  const originalManifest = await readFile(npmManifest, "utf8");
  const bundled = await evaluate(
    `audit.invoke('format_document',{path:${js(npmManifest)},text:${js(originalManifest)},language:'json'})`,
  );
  assert.deepEqual(JSON.parse(bundled), JSON.parse(originalManifest));
  assert.equal(await readFile(npmManifest, "utf8"), originalManifest);
  assert.equal(await exists(path.join(data, "tools/languages")), false);
  await writeFile(path.join(data, "settings.json"), js({ "litecode.nodePath": null }));
  const missingNode = await evaluate(
    `audit.invoke('format_document',{path:${js(npmManifest)},text:'{}',language:'json'}).catch(e=>e)`,
  );
  assert.equal(missingNode.code, "missingTool", js(missingNode));
  assert.match(missingNode.message, /Node.js is required for formatting/);
  checks.push(
    "Packaged Prettier works without project Prettier or Language Tools, and missing Node.js reports an actionable error",
  );
  await evaluate(`audit.languages.stopLanguages()`);
  assert.deepEqual(consoleErrors, []);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(run, "verified.png"), Buffer.from(screenshot.data, "base64"));
  await writeFile(path.join(run, "results.json"), js({ checks, consoleErrors }));
  console.log(JSON.stringify({ run, checks }, null, 2));
} catch (error) {
  const debug = await evaluate?.(
    `({body:document.body.innerText.slice(-2000),done:window.audit?.done,error:window.audit?.error,calls:window.audit?.calls})`,
  ).catch(() => null);
  await writeFile(
    path.join(run, "failure.json"),
    js({ error: String(error), checks, debug, consoleErrors }),
  );
  throw error;
} finally {
  socket?.close();
  child?.kill();
  vite?.kill();
}
