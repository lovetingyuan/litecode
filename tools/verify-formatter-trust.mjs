// Requires a Debug build and installed Language Tools (or PRETTIER_DIR).
// All application data, code execution markers and trust decisions are isolated.
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, readFile, writeFile, access, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const run = path.resolve(".verification", `formatter-trust-${Date.now()}`);
const app = path.join(run, "app");
const data = path.join(app, "data");
const loose = path.join(run, "loose");
const workspace = path.join(run, "workspace");
const file = path.join(loose, "a.html");
const marker = path.join(run, "script-executed");
const configMarker = path.join(run, "config-executed");
const prettier = process.env.PRETTIER_DIR ?? path.join(process.env.APPDATA, "com.tingyuan.litecode/tools/languages/node_modules/prettier");
const js = JSON.stringify;
const exists = filename => access(filename).then(() => true, () => false);
for (const folder of [data, loose, workspace, path.join(loose, "node_modules/prettier/bin")]) { await mkdir(folder, { recursive: true }); }
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await cp(prettier, path.join(data, "tools/languages/node_modules/prettier"), { recursive: true });
for (const name of ["oxfmt", "tinypool", "@oxfmt"]) {
  await cp(path.join(path.dirname(prettier), name), path.join(data, "tools/languages/node_modules", name), { recursive: true });
}
await writeFile(file, "<p>original</p>");
await writeFile(path.join(workspace, "a.html"), "<div><p>text</p></div>");
await writeFile(path.join(loose, "node_modules/prettier/bin/prettier.cjs"), `require('node:fs').writeFileSync(${js(marker)},'executed');console.error('AUDIT_FORMATTER_EXECUTED');process.exit(1);`);
await writeFile(path.join(run, "prettier.config.cjs"), `require('node:fs').writeFileSync(${js(configMarker)},'executed');module.exports={tabWidth:4,htmlWhitespaceSensitivity:'ignore',printWidth:10};`);
await writeFile(path.join(data, "settings.json"), js({ "files.autoSave": "off", "editor.formatOnSave": true, "litecode.nodePath": process.execPath }));
await writeFile(path.join(data, "session-main.json"), js({ root: null, documents: [], session: {} }));
let vite, child, socket, evaluate;
const checks = [];
const consoleErrors = [];

async function waitFor(check, description) {
  const until = Date.now() + 60_000;
  let last;
  while (Date.now() < until) {
    try { const result = await check(); if (result) { return result; } } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: ${last ?? "timeout"}`);
}

try {
  if (!(await fetch("http://localhost:1420").catch(() => null))?.ok) {
    vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"], { windowsHide: true, stdio: "ignore" });
    await waitFor(async () => (await fetch("http://localhost:1420").catch(() => null))?.ok, "Vite startup");
  }
  const appSource = await fetch("http://localhost:1420/src/components/App.tsx").then(r => r.text());
  const imports = [...appSource.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
  const moduleUrl = filename => {
    const url = imports.find(url => url.split("?")[0] === filename);
    assert.ok(url, `App must import ${filename}`);
    return new URL(url, "http://localhost:1420").href;
  };
  child = spawn(path.join(app, "LiteCode.exe"), [], { cwd: app, windowsHide: true, stdio: "ignore", env: {
    ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9236", WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
  } });
  const target = await waitFor(async () => (await fetch("http://127.0.0.1:9236/json/list").then(r => r.json()))
    .find(target => target.type === "page" && target.url.includes("1420")), "Isolated WebView startup");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") { consoleErrors.push(message.params.exceptionDetails.text); }
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id); clearTimeout(callback.timer);
      if (message.error) { callback.reject(message.error); } else { callback.resolve(message.result); }
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 60_000);
    pending.set(key, { resolve, reject, timer }); socket.send(js({ id: key, method, params }));
  });
  evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) { throw new Error(JSON.stringify(result.exceptionDetails)); }
    return result.result.value;
  };
  await send("Runtime.enable");
  await waitFor(() => evaluate(`(async()=>{const {useApp}=await import(${js(moduleUrl("/src/store/store.ts"))});return useApp.getState().ready})()`), "App bootstrap");
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
  const rawError = await evaluate(`audit.invoke('format_document',{path:audit.file,text:'<p>original</p>',language:'html'}).catch(e=>e)`);
  assert.equal(rawError.code, "formatterTrust");
  assert.equal(path.resolve(rawError.trustPath), loose);
  assert.equal(await exists(marker), false);
  checks.push("Native loose-file formatting rejects untrusted code before spawning a process");

  const click = async label => {
    await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${js(label)})`), `Dialog button ${label}`);
    const point = await evaluate(`(()=>{const r=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${js(label)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  await evaluate(`audit.docs.models.get(audit.id).setValue('<p>saved without formatter</p>');audit.done=false;void audit.docs.save(audit.id).then(()=>{audit.done=true})`);
  await click("Cancel");
  await waitFor(() => evaluate(`audit.done`), "Save after refusing trust");
  assert.equal(await exists(marker), false);
  assert.equal(await readFile(file, "utf8"), "<p>saved without formatter</p>");
  checks.push("Refusing the actual save-time trust dialog preserves editing and saves the current buffer without executing the script");

  await evaluate(`audit.done=false;void audit.languages.formatModel(audit.docs.models.get(audit.id)).then(()=>{audit.done=true},e=>{audit.error=e;audit.done=true})`);
  await click("Trust Formatters");
  // The ancestor configuration is another source outside the approved loose folder.
  await click("Trust Formatters");
  await waitFor(() => evaluate(`audit.done`), "Approved formatter execution");
  assert.equal(await exists(marker), true);
  assert.equal((await evaluate(`audit.error`)).code, "formatter");
  assert.match((await evaluate(`audit.error`)).message, /AUDIT_FORMATTER_EXECUTED/);
  assert.equal(await exists(configMarker), false);
  checks.push("Only explicit folder and ancestor-config approval allows the harmless project script to execute");

  await evaluate(`(async()=>{
    await audit.languages.stopLanguages();
    await audit.invoke('explicit_open',{path:${js(workspace)}});
    await audit.invoke('open_workspace',{path:${js(workspace)},newWindow:false});
    const boot=await audit.invoke('bootstrap');audit.store.setApp({root:boot.root});
    await audit.invoke('set_workspace_trust',{expectedRoot:boot.root,trusted:true});
  })()`);
  assert.equal((await evaluate(`audit.invoke('format_document',{path:audit.file,text:'<p>text</p>',language:'html'}).catch(e=>e)`)).code, "formatterTrust");
  checks.push("Trusting an unrelated workspace does not authorize an outside file or reuse the loose-window grant");
  const inside = path.join(workspace, "a.html");
  const configError = await evaluate(`audit.invoke('format_document',{path:${js(inside)},text:'<div><p>text</p></div>',language:'html'}).catch(e=>e)`);
  assert.equal(configError.code, "formatterTrust");
  assert.equal(path.resolve(configError.trustPath), run);
  assert.equal(await exists(configMarker), false);
  await evaluate(`audit.invoke('trust_formatter',{path:${js(inside)},expectedRoot:audit.store.useApp.getState().root,directory:${js(run)}})`);
  const formatted = await evaluate(`audit.invoke('format_document',{path:${js(inside)},text:'<div><p>text</p></div>',language:'html'})`);
  assert.match(formatted, /\n {4}<p>/);
  assert.equal(await exists(configMarker), true);
  checks.push("Installed Prettier loads an ancestor configuration only after that source is approved and formats correctly");
  await writeFile(path.join(workspace, "package.json"), js({ prettier: { htmlWhitespaceSensitivity: "ignore", printWidth: 10, tabWidth: 2 } }));
  const packageFormatted = await evaluate(`audit.invoke('format_document',{path:${js(inside)},text:'<div><p>text</p></div>',language:'html'})`);
  assert.match(packageFormatted, /\n {2}<p>/);
  checks.push("Explicit Prettier configuration preserves package.json settings and nearest-config precedence");

  await writeFile(path.join(data, "settings.json"), js({ "files.autoSave": "off", "litecode.nodePath": process.execPath, "editor.defaultFormatter": "oxc.oxc-vscode" }));
  const typescript = path.join(workspace, "a.ts");
  await writeFile(typescript, "const x=1");
  let oxfmt = await evaluate(`audit.invoke('format_document',{path:${js(typescript)},text:'const x=1',language:'typescript'})`);
  assert.match(oxfmt, /const x = 1/);
  await writeFile(path.join(workspace, "oxfmt.config.ts"), "export default {semi:false};");
  oxfmt = await evaluate(`audit.invoke('format_document',{path:${js(typescript)},text:'const x=1;',language:'typescript'})`);
  assert.doesNotMatch(oxfmt, /;/);
  await unlink(path.join(workspace, "oxfmt.config.ts"));
  await writeFile(path.join(data, "settings.json"), js({ "files.autoSave": "off", "litecode.nodePath": process.execPath, "editor.defaultFormatter": "oxc.oxc-vscode", "oxfmt.path": process.execPath }));
  const executableError = await evaluate(`audit.invoke('format_document',{path:${js(typescript)},text:'const x=1',language:'typescript'}).catch(e=>e)`);
  assert.equal(executableError.code, "formatterTrust");
  assert.equal(path.resolve(executableError.trustPath), path.dirname(process.execPath));
  checks.push("A configured formatter executable outside the workspace needs its own source approval");
  const rust = path.join(workspace, "a.rs");
  await writeFile(rust, "fn main(){let x=1;}");
  const rustfmt = await evaluate(`audit.invoke('format_document',{path:${js(rust)},text:'fn main(){let x=1;}',language:'rust'})`);
  assert.match(rustfmt, /let x = 1;/);
  checks.push("Real Oxfmt accepts both the pinned empty default and TypeScript config; Rustfmt accepts the pinned empty default");
  assert.deepEqual(consoleErrors, []);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(run, "verified.png"), Buffer.from(screenshot.data, "base64"));
  await writeFile(path.join(run, "results.json"), js({ checks, consoleErrors }));
  console.log(JSON.stringify({ run, checks }, null, 2));
} catch (error) {
  const debug = await evaluate?.(`({body:document.body.innerText.slice(-2000),done:window.audit?.done,error:window.audit?.error,calls:window.audit?.calls})`).catch(() => null);
  await writeFile(path.join(run, "failure.json"), js({ error: String(error), checks, debug, consoleErrors }));
  throw error;
} finally {
  socket?.close(); child?.kill(); vite?.kill();
}
